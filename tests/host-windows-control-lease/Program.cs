using System.Drawing;
using UnboundVnc.Host.Windows;

var assertions=0;
void Check(bool value,string message) {
    if(!value)throw new InvalidOperationException(message);
    assertions++;
}

var time=DateTimeOffset.UtcNow;
var target=new ControlTarget((nint)0x42, 8901, new Rectangle(100,100,420,220), "SYNTHETIC_TEST_OWNED_WINDOW");
var other=new ControlTarget((nint)0x61, 8902, new Rectangle(200,200,420,220), "SYNTHETIC_OTHER_WINDOW");
var lease=new AttendedControlLease();
var obs=new ControlObservation(12, target.WindowHandle, target.ProcessId, target.Bounds,
    defaultDesktop:true,sessionCurrent:true,now:time);
var click=new NormalizedPointer(140,145,1);
var type=new NormalizedKey(true,LocalKeyKind.Printable,'a');
Check(!lease.TryConsumeKey(type,obs,1),"default denied key");
Check(!lease.TryConsumePointer(click,obs,1),"default denied pointer");
Check(!lease.Grant(LocalInputConsent.ViewOnly,target,12,time.AddMinutes(2)),
    "view-only cannot grant native control");
Check(!lease.TryConsumeKey(type,obs,1),"still denied after view-only");
Check(lease.Grant(LocalInputConsent.AllowControl,target,12,time.AddMinutes(2)),
    "explicit control grant rejected");
Check(!lease.TryConsumeKey(type,obs with {ForegroundRoot=other.WindowHandle},1),
    "wrong foreground window input");
Check(!lease.TryConsumePointer(click,obs with {ForegroundOwnerPid=other.ProcessId},1),
    "wrong foreground owner");
Check(!lease.TryConsumeKey(type,obs with {SessionEpoch=11},1),"stale session epoch");
Check(!lease.TryConsumeKey(type,obs with {DefaultDesktop=false},1),"locked desktop");
Check(!lease.TryConsumeKey(type,obs with {SessionCurrent=false},1),"revoked remote session");
Check(!lease.TryConsumeKey(type,obs with {Now=time.AddMinutes(3)},1),"expired control");
Check(!lease.TryConsumePointer(new NormalizedPointer(1,1,1),obs,1),"pointer outside approved window");
Check(!lease.TryConsumePointer(click,obs with {TargetBounds=new Rectangle(10,10,50,50)},1),
    "window moved or resized after consent");
Check(!lease.TryConsumeKey(new NormalizedKey(true,LocalKeyKind.Enter,'\0'),obs,1),
    "Enter can submit and requires separate explicit send permission");
Check(lease.IsCurrent(obs),"current authorization inspection failed");
Check(lease.TryConsumePointer(click,obs,1),"first valid pointer refused");
Check(!lease.TryConsumePointer(click,obs,1),"same event sequence replayed");
Check(lease.TryConsumeKey(type,obs,2),"valid key refused");
Check(!lease.TryConsumeKey(type,obs,1),"out-of-order event accepted");
lease.Revoke();
Check(!lease.IsCurrent(obs),"revoked lease still reported current");
Check(!lease.TryConsumePointer(click,obs,3),"input accepted after revoke");
Check(!lease.TryConsumeKey(type,obs,3),"key accepted after revoke");
Check(!lease.Grant(LocalInputConsent.AllowControl,target,12,time.AddMinutes(2)),
    "revoked epoch silently rearmed");
Check(lease.Grant(LocalInputConsent.AllowControl,target,13,time.AddMinutes(2)),
    "new session epoch could not grant");
Check(!lease.TryConsumeKey(type,obs,1),"stale foreground epoch accepted after fresh grant");
var obs13=obs with {SessionEpoch=13};
Check(lease.TryConsumeKey(type,obs13,1),"new epoch must allow fresh sequence");
var forbidden=new AttendedControlLease();
Check(!forbidden.Grant(LocalInputConsent.AllowControl,
    target with {Kind="FIREFOX_CHAT"},15,time.AddMinutes(2)),
    "real Firefox window unexpectedly authorized by synthetic-only policy");
Check(!forbidden.Grant(LocalInputConsent.AllowControl,
    target with {Kind="SYNTHETIC_TEST_OWNED_WINDOW",WindowHandle=0},15,time.AddMinutes(2)),
    "zero HWND accepted");
Check(!forbidden.Grant(LocalInputConsent.AllowControl,
    target with {Kind="SYNTHETIC_TEST_OWNED_WINDOW",ProcessId=0},15,time.AddMinutes(2)),
    "unowned PID accepted");
Check(!forbidden.Grant(LocalInputConsent.AllowControl,
    target with {Bounds=new Rectangle(10,10,1281,700)},15,time.AddMinutes(2)),
    "oversized target accepted");
Check(!forbidden.Grant(LocalInputConsent.AllowControl,target,15,time.AddMinutes(6)),
    "unbounded control lease accepted");
Check(!forbidden.Grant(LocalInputConsent.AllowControl,target,15,time.AddSeconds(-1)),
    "expired control lease accepted");var second=new AttendedControlLease();
var events = new List<string>();
Check(!RfbInputDispatch.TryKey(second, Key(0x61), obs13, 1,
    key=>{events.Add("KEY");return true;}),"default key reached effect callback");
Check(events.Count==0,"default key side effect");
Check(second.Grant(LocalInputConsent.AllowControl,target,13,time.AddMinutes(2)),
    "synthetic lease denied");
Check(RfbInputDispatch.TryKey(second,Key(0x61),obs13,1,
    key=>{events.Add("KEY:"+key.Character);return true;}),"authorized synthetic key refused");
Check(events.Count==1&&events[0]=="KEY:a","exact intended key was not delivered");
Check(!RfbInputDispatch.TryKey(second,Key(0x61),obs13,1,
    key=>{events.Add("REPLAY");return true;}),"duplicate key entered effect");
Check(!RfbInputDispatch.TryKey(second,Key(0xff0d),obs13,2,
    key=>{events.Add("ENTER");return true;}),"Enter submitted without separate approval");
Check(RfbInputDispatch.TryPointer(second,Pointer(1,40,45),1280,720,100,100,
    obs13,2,ptr=>{events.Add("POINTER:"+ptr.ScreenX);return true;}),
    "allowed synthetic pointer denied");
Check(events.Count==2&&events[1]=="POINTER:140","pointer did not route correctly");
second.Revoke();
Check(!RfbInputDispatch.TryKey(second,Key(0x61),obs13,3,
    key=>{events.Add("AFTER_REVOKE");return true;}),"revoked key entered effect");
Check(events.Count==2,"effect occurred after Stop");
var atomicLease=new AttendedControlLease();
Check(atomicLease.Grant(LocalInputConsent.AllowControl,target,14,time.AddMinutes(2)),
    "atomic lease grant refused");
var obs14=obs with {SessionEpoch=14};
var effectStarted=new System.Threading.ManualResetEventSlim();
var releaseEffect=new System.Threading.ManualResetEventSlim();
var callbackFinished=false;
var delivery=Task.Run(()=>RfbInputDispatch.TryKey(
    atomicLease,Key(0x61),obs14,1,key=>{
        effectStarted.Set();
        if(!releaseEffect.Wait(TimeSpan.FromSeconds(5)))
            throw new InvalidOperationException("blocked fixture effect");
        callbackFinished=true;
        return true;
    }));
Check(effectStarted.Wait(TimeSpan.FromSeconds(5)),"effect never started");
var revokeFinished=false;
var revokeTask=Task.Run(()=>{atomicLease.Revoke();revokeFinished=true;});
System.Threading.Thread.Sleep(80);
Check(!revokeFinished,"Stop acknowledged before already-started effect was serialized");
releaseEffect.Set();
Check(delivery.GetAwaiter().GetResult(),"atomic delivery returned false");
revokeTask.GetAwaiter().GetResult();
Check(callbackFinished&&revokeFinished,"atomic effect and revoke ordering was wrong");
Check(!RfbInputDispatch.TryKey(atomicLease,Key(0x61),obs14,2,
    key=>throw new InvalidOperationException("effect after revoked")),
    "post-revocation delivery escaped");
var beforeCapture=DateTimeOffset.UtcNow.AddSeconds(-1);
var captured=TrustedControlObservation.Capture(200, sessionCurrent:false);
var afterCapture=DateTimeOffset.UtcNow.AddSeconds(1);
Check(captured.Now>=beforeCapture&&captured.Now<=afterCapture,
    "host observation time cannot be provided by RFB client");
Check(!captured.SessionCurrent,"host false session was silently promoted");
Check(captured.SessionEpoch==200,"epoch binding changed");
var observedLease=new AttendedControlLease();
Check(observedLease.Grant(LocalInputConsent.AllowControl,target,200,time.AddMinutes(2)),
    "synthetic test lease missing");
Check(!observedLease.TryConsumeKey(type,captured,1),
    "real OS observation of unapproved session accepted fake input");
var testQueuedApplyGate=new AttendedControlLease();
Check(testQueuedApplyGate.Grant(LocalInputConsent.AllowControl,target,22,time.AddMinutes(2)),
    "queued apply setup failed");
var queuedObs=obs with {SessionEpoch=22};
int applied=0;
Check(!testQueuedApplyGate.TryApplyWhileCurrent(
    queuedObs with {ForegroundRoot=other.WindowHandle},()=>applied++),
    "wrong-foreground queued effect applied");
Check(applied==0,"wrong-foreground callback actually ran");
var applyStarted=new System.Threading.ManualResetEventSlim();
var releaseApply=new System.Threading.ManualResetEventSlim();
bool revokeApplyDone=false;
var pendingApply=Task.Run(()=>testQueuedApplyGate.TryApplyWhileCurrent(
    queuedObs,()=>{
        applyStarted.Set();
        if(!releaseApply.Wait(TimeSpan.FromSeconds(5)))
            throw new InvalidOperationException("timed out queued UI effect");
        Interlocked.Increment(ref applied);
    }));
Check(applyStarted.Wait(TimeSpan.FromSeconds(5)),"queued apply never started");
var revokeQueued=Task.Run(()=>{testQueuedApplyGate.Revoke();revokeApplyDone=true;});
System.Threading.Thread.Sleep(100);
Check(!revokeApplyDone,"Stop acknowledged while queued UI callback was in progress");
releaseApply.Set();
Check(pendingApply.GetAwaiter().GetResult(),"queued effect was incorrectly dropped");
revokeQueued.GetAwaiter().GetResult();
Check(applied==1&&revokeApplyDone,"queued UI callback/revoke ordering wrong");
Check(!testQueuedApplyGate.TryApplyWhileCurrent(queuedObs,()=>applied++),
    "revoked queued effect applied");
Check(applied==1,"UI effect occurred after Stop ACK");
var monotonicLease = new AttendedControlLease();
var earlyObservation = DateTimeOffset.UtcNow;
var shortExpiry = earlyObservation.AddMilliseconds(360);
Check(monotonicLease.Grant(LocalInputConsent.AllowControl, target, 555,
    shortExpiry), "short monotonic lease grant denied");
var staleObserved = obs with { SessionEpoch = 555, Now = earlyObservation };
System.Threading.Thread.Sleep(480);
int staleEffects = 0;
Check(!RfbInputDispatch.TryKey(monotonicLease, Key(0x61), staleObserved, 1,
    key=>{ staleEffects++; return true; }),
    "cached pre-expiry observation must NOT grant post-expiry input");
Check(staleEffects == 0, "stale-time callback executed after expiry");
Check(!monotonicLease.IsCurrent(staleObserved),
    "stale-time UI queue check still current after real expiry");
var preGrantFence=new RfbTestInputFence();
Check(!preGrantFence.Ready, "view-only input fence unexpectedly ready");
Check(!preGrantFence.TryIssueChallenge(false,out _),"pregrant request issued a control token");
Check(!preGrantFence.Ready,"pregrant request unlocked control");
var bufferedKey=Key(0x7a);
var syntheticDelivered="";
var safeInputLease=new AttendedControlLease();
Check(safeInputLease.Grant(LocalInputConsent.AllowControl,target,600,
    DateTimeOffset.UtcNow.AddMinutes(2)),"fence test-only lease denied");
var fenceObs=obs with {SessionEpoch=600};
Check(preGrantFence.TryIssueChallenge(true,out var issuedChallenge),
    "postgrant challenge missing");
Check(issuedChallenge.StartsWith(RfbTestInputFence.ChallengePrefix,StringComparison.Ordinal),
    "wrong challenge envelope");
Check(!preGrantFence.Ready,"challenge issued but not confirmed");
Check(!(preGrantFence.Ready && RfbInputDispatch.TryKey(safeInputLease,
    bufferedKey,fenceObs,1,key=>{syntheticDelivered+=key.Character;return true;})),
    "old buffered z promoted before challenge response");
Check(syntheticDelivered=="","old z became a test effect");
Check(!preGrantFence.TryIssueChallenge(true,out _),"challenge was reissued");
var nonce=issuedChallenge[RfbTestInputFence.ChallengePrefix.Length..];
var response=RfbTestInputFence.ResponsePrefix+nonce;
Check(preGrantFence.TryConfirm(true,response),"fresh correct postgrant response denied");
Check(preGrantFence.Ready,"confirmed control fence not ready");
Check(!preGrantFence.TryConfirm(true,response),"replay of control response accepted");
Check(preGrantFence.Ready,"duplicate echo should not expand control permission");
Check(preGrantFence.Ready && RfbInputDispatch.TryKey(safeInputLease,Key(0x61),
    fenceObs,2,key=>{syntheticDelivered+=key.Character;return true;}),
    "new postgrant a refused");
Check(syntheticDelivered=="a","old pregrant input leaked or postgrant lost");
preGrantFence.Invalidate();
Check(!preGrantFence.Ready,"Stop failed to revoke transport fence");
Check(!preGrantFence.TryConfirm(true,response),"revoked control response accepted");
var foreignFence=new RfbTestInputFence();
Check(foreignFence.TryIssueChallenge(true,out _),"foreign challenge setup failed");
Check(!foreignFence.TryConfirm(true,response),"foreign replay authorized control");
Check(!foreignFence.Ready,"foreign replay unlocked control");
var wrongFence=new RfbTestInputFence();
Check(wrongFence.TryIssueChallenge(true,out var wrongChallenge),"wrong-nonce setup failed");
Check(!wrongFence.TryConfirm(true,RfbTestInputFence.ResponsePrefix+
    new string('A',43)),"forged response accepted");
Check(!wrongFence.Ready,"wrong response unlocked control");
Check(!wrongFence.TryConfirm(true,RfbTestInputFence.ResponsePrefix+
    wrongChallenge[RfbTestInputFence.ChallengePrefix.Length..]),
    "failed connection silently rearmed");
var noncanonicalFence=new RfbTestInputFence();
Check(noncanonicalFence.TryIssueChallenge(true,out var canonChallenge),
    "noncanonical witness setup refused");
string canonNonce=canonChallenge[RfbTestInputFence.ChallengePrefix.Length..];
const string alphabet="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
int lastIndex=alphabet.IndexOf(canonNonce[^1]);
Check(lastIndex>=0,"generated base64url nonce was invalid");
string altNonce=canonNonce[..^1]+alphabet[lastIndex ^ 1];
Check(altNonce!=canonNonce,"negative nonce must differ");
Check(!noncanonicalFence.TryConfirm(true,RfbTestInputFence.ResponsePrefix+altNonce),
    "noncanonical final base64url bits were accepted");
Check(!noncanonicalFence.Ready,"noncanonical response unlocked test input");
Check(!NativeOwnedTestFormInput.TryTypeTestChar(
    new NormalizedKey(true,LocalKeyKind.Printable,'a'), nint.Zero,
    new Rectangle(0,0,320,200),true,1,true),
    "zero native target HWND unexpectedly accepted test key");
Check(!NativeOwnedTestFormInput.TryTypeTestChar(
    new NormalizedKey(true,LocalKeyKind.Printable,'a'), (nint)42,
    new Rectangle(0,0,320,200),false,1,true),
    "unfocused test field unexpectedly accepted key");
Check(!NativeOwnedTestFormInput.TryTypeTestChar(
    new NormalizedKey(true,LocalKeyKind.Printable,'A'), (nint)42,
    new Rectangle(0,0,320,200),true,1,true),
    "out-of-scope uppercase input accepted");
Check(!NativeOwnedTestFormInput.TryClickTestButton(
    new NormalizedPointer(101,101,1),nint.Zero,
    new Rectangle(0,0,320,200),new Rectangle(90,90,60,60),1,true),
    "zero target HWND unexpectedly accepted native pointer");
Check(!NativeOwnedTestFormInput.TryClickTestButton(
    new NormalizedPointer(101,101,2),(nint)42,
    new Rectangle(0,0,320,200),new Rectangle(90,90,60,60),1,true),
    "right-button input unexpectedly accepted");

// Source-linked hostile regression: a failing native effect is an
// indeterminate partial effect, not permission to retry with the same lease.
var failKeyLease=new AttendedControlLease();
var failKeyObs=obs with {SessionEpoch=701,Now=DateTimeOffset.UtcNow};
Check(failKeyLease.Grant(LocalInputConsent.AllowControl,target,701,
    DateTimeOffset.UtcNow.AddMinutes(1)), "throwing key setup denied");
int failKeyCalls=0;
bool keyThrew=false;
try {
    _=failKeyLease.TryDeliverKey(type,failKeyObs,1,_=>{
        failKeyCalls++;
        throw new InvalidOperationException("TEST_ONLY_KEY_EFFECT_THROW");
    });
}
catch(InvalidOperationException ex) when (ex.Message=="TEST_ONLY_KEY_EFFECT_THROW") {
    keyThrew=true;
}
Check(keyThrew&&failKeyCalls==1,"throwing key effect not observed exactly once");
Check(!failKeyLease.IsCurrent(failKeyObs),"throwing key left control active");
Check(!failKeyLease.TryDeliverKey(type,failKeyObs,2,_=>{failKeyCalls++;return true;}),
    "throwing key allowed next event");
Check(failKeyCalls==1,"next key callback ran after exception");
Check(!failKeyLease.Grant(LocalInputConsent.AllowControl,target,701,
    DateTimeOffset.UtcNow.AddMinutes(1)),"failed key silently rearmed same epoch");

var failPointerLease=new AttendedControlLease();
var failPointerObs=obs with {SessionEpoch=702,Now=DateTimeOffset.UtcNow};
Check(failPointerLease.Grant(LocalInputConsent.AllowControl,target,702,
    DateTimeOffset.UtcNow.AddMinutes(1)), "throwing pointer setup denied");
int failPointerCalls=0;
bool pointerThrew=false;
try {
    _=failPointerLease.TryDeliverPointer(click,failPointerObs,1,_=>{
        failPointerCalls++;
        throw new InvalidOperationException("TEST_ONLY_POINTER_EFFECT_THROW");
    });
}
catch(InvalidOperationException ex) when(ex.Message=="TEST_ONLY_POINTER_EFFECT_THROW") {
    pointerThrew=true;
}
Check(pointerThrew&&failPointerCalls==1,"throwing pointer effect not observed exactly once");
Check(!failPointerLease.IsCurrent(failPointerObs),"throwing pointer left control active");
Check(!failPointerLease.TryDeliverPointer(click,failPointerObs,2,_=>{failPointerCalls++;return true;}),
    "throwing pointer allowed next event");
Check(failPointerCalls==1,"next pointer callback ran after exception");

var failUiLease=new AttendedControlLease();
var failUiObs=obs with {SessionEpoch=703,Now=DateTimeOffset.UtcNow};
Check(failUiLease.Grant(LocalInputConsent.AllowControl,target,703,
    DateTimeOffset.UtcNow.AddMinutes(1)), "throwing UI setup denied");
int failUiCalls=0;
bool uiThrew=false;
try {
    _=failUiLease.TryApplyWhileCurrent(failUiObs,()=>{
        failUiCalls++;
        throw new InvalidOperationException("TEST_ONLY_QUEUED_EFFECT_THROW");
    });
}
catch(InvalidOperationException ex) when(ex.Message=="TEST_ONLY_QUEUED_EFFECT_THROW") {
    uiThrew=true;
}
Check(uiThrew&&failUiCalls==1,"throwing queued effect not observed exactly once");
Check(!failUiLease.IsCurrent(failUiObs),"throwing queued effect left control active");
Check(!failUiLease.TryApplyWhileCurrent(failUiObs,()=>failUiCalls++),
    "throwing queued effect allowed follow-on callback");
Check(failUiCalls==1,"queued callback ran after exception");

var falseLease=new AttendedControlLease();
var falseObs=obs with {SessionEpoch=704,Now=DateTimeOffset.UtcNow};
Check(falseLease.Grant(LocalInputConsent.AllowControl,target,704,
    DateTimeOffset.UtcNow.AddMinutes(1)), "false-return setup denied");
Check(!falseLease.TryDeliverKey(type,falseObs,1,_=>false),
    "false effect was misreported as success");
Check(!falseLease.IsCurrent(falseObs),"false effect retained control");
Check(!falseLease.TryDeliverKey(type,falseObs,2,_=>true),
    "failed effect was retried under old approval");

Console.WriteLine("CONTROL_LEASE_GATE_PASS="+assertions);

static byte[] Key(uint keysym)
{
    var payload=new byte[7];
    payload[0]=1;
    System.Buffers.Binary.BinaryPrimitives.WriteUInt32BigEndian(payload.AsSpan(3),keysym);
    return payload;
}
static byte[] Pointer(byte buttons,ushort x,ushort y)
{
    var payload=new byte[5];
    payload[0]=buttons;
    System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(payload.AsSpan(1,2),x);
    System.Buffers.Binary.BinaryPrimitives.WriteUInt16BigEndian(payload.AsSpan(3,2),y);
    return payload;
}