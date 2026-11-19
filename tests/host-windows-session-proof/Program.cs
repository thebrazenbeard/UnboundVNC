using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using UnboundVnc.Host.Windows;

int assertions=0;
void Check(bool condition,string message) {
    if (!condition) throw new Exception(message);
    assertions++;
}
var key=Enumerable.Range(0,32).Select(i=>(byte)i).ToArray();
var encoded=RfbSessionProof.EncodeKey(key);
Check(encoded.Length==43,"key length");
Check(RfbSessionProof.ParseKey(encoded).SequenceEqual(key),"key round trip");
foreach(var bad in new[]{"", "bad-key", encoded+"=", encoded[..42]+"+", encoded[..42]+"B"}) {
    try {
        var parsed=RfbSessionProof.ParseKey(bad);
        Check(false,"bad key accepted "+bad[..Math.Min(6,bad.Length)]);
    }catch(FormatException) {}
}
var challenge=Enumerable.Range(0,32).Select(i=>(byte)(200+i)).ToArray();
var expected=HMACSHA256.HashData(key,
    Encoding.ASCII.GetBytes("UNBOUNDVNC-ATTENDED-RFB-PROOF-v1:")
        .Concat(challenge).ToArray());
Check(RfbSessionProof.ComputeResponse(key,challenge).SequenceEqual(expected),
    "expected host challenge HMAC");
Check(!RfbSessionProof.ComputeResponse(key,new byte[32]).SequenceEqual(expected),
    "challenge cannot be replayed");

using var listener=new TcpListener(IPAddress.Loopback,0);
listener.Start(1);
using var gateway=new TcpClient();
await gateway.ConnectAsync((IPEndPoint)listener.LocalEndpoint);
using var host=await listener.AcceptTcpClientAsync();
var task=RfbSessionProof.ProveAsync(host.GetStream(),key,CancellationToken.None);
var marker=new byte[5];
await gateway.GetStream().ReadExactlyAsync(marker);
Check(Encoding.ASCII.GetString(marker)=="UVNC1","marker must precede proof");
await gateway.GetStream().WriteAsync(challenge);
var response=new byte[32];
await gateway.GetStream().ReadExactlyAsync(response);
await task;
Check(response.SequenceEqual(expected),"proof over real local TCP");
listener.Stop();
Console.WriteLine("SESSION_PROOF_CHECKS_PASS="+assertions);