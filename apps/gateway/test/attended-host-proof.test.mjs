import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { createGateway } from '../src/server.mjs';

const KEY=Buffer.alloc(32,0x3b);
const DOMAIN='UNBOUNDVNC-ATTENDED-RFB-PROOF-v1:';

async function createFixture(onPeer) {
  const peers=new Set();
  const upstream=createServer(socket=>{
    peers.add(socket);
    socket.once('close',()=>peers.delete(socket));
    socket.on('error',()=>{});
    onPeer(socket);
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const gateway=createGateway({
    host:'127.0.0.1',port:0,allowedPorts:[upstream.address().port],
    maxSessions:1,greetingTimeoutMs:8000,attendedHostKey:KEY,
  });
  const url=await gateway.listen();
  async function close(){
    for(const peer of peers)peer.destroy();
    await gateway.close();
    await new Promise(resolve=>upstream.close(resolve));
  }
  return {url,upstream,close};
}

async function upgrade(url,upstreamPort){
  const origin=new URL(url).origin;
  const response=await fetch(new URL('/api/sessions',url),{
    method:'POST',headers:{Origin:origin,'content-type':'application/json'},
    body:JSON.stringify({host:'127.0.0.1',port:upstreamPort}),
  });
  assert.equal(response.status,201);
  const ticket=await response.json();
  const socket=connect({host:'127.0.0.1',port:Number(new URL(url).port)});
  socket.on('error',()=>{});
  const request=[
    'GET '+ticket.wsPath+' HTTP/1.1',
    'Host: '+new URL(url).host,
    'Origin: '+origin,
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Key: '+randomBytes(16).toString('base64'),
    'Sec-WebSocket-Version: 13',
    '', '',
  ].join('\r\n');
  socket.write(request);
  try {
    const result=await new Promise((resolve,reject)=>{
      let data=Buffer.alloc(0);
      const timer=setTimeout(()=>reject(new Error('UPGRADE_TIMEOUT')),4200);
      socket.on('data',chunk=>{
        data=Buffer.concat([data,chunk]);
        const end=data.indexOf('\r\n\r\n');
        if(end!==-1){
          clearTimeout(timer);
          resolve({header:data.subarray(0,end+4).toString('ascii'),
                    trailing:data.subarray(end+4)});
        }
      });
      socket.once('close',()=>{clearTimeout(timer);resolve({header:'CLOSED_NO_UPGRADE',trailing:Buffer.alloc(0)})});
    });
    return result;
  } finally {socket.destroy()}
}

test('attended host proof refuses an RFB-looking listener with no secret', {timeout:9000}, async()=>{
  const f=await createFixture(socket=>socket.write('RFB 003.008\n'));
  try{
    const result=await upgrade(f.url,f.upstream.address().port);
    assert.doesNotMatch(result.header,/101 Switching Protocols/,
      'a port-5901 lookalike must not graduate to a browser WebSocket');
  } finally {await f.close()}
});

test('only valid post-approval challenge response graduates and hides proof from browser', {timeout:9000}, async()=>{
  const f=await createFixture(socket=>{
    socket.write('UVNC1');
    let incoming=Buffer.alloc(0);
    socket.on('data',chunk=>{
      incoming=Buffer.concat([incoming,chunk]);
      if(incoming.length<32)return;
      const challenge=incoming.subarray(0,32);
      const response=createHmac('sha256',KEY).update(DOMAIN).update(challenge).digest();
      socket.write(Buffer.concat([response,Buffer.from('RFB 003.008\n')]));
      socket.removeAllListeners('data');
    });
  });
  try{
    const result=await upgrade(f.url,f.upstream.address().port);
    assert.match(result.header,/101 Switching Protocols/);
    assert.equal(result.trailing.includes(Buffer.from('UVNC1')),false);
  } finally {await f.close()}
});

test('attended host proof refuses unsafe key formats and multi-target connections', ()=>{
  assert.throws(()=>createGateway({
    allowedPorts:[5901],maxSessions:1,greetingTimeoutMs:8000,
    attendedHostKey:Buffer.alloc(16),
  }),/attended|host.*key/i);
  assert.throws(()=>createGateway({
    allowedPorts:[5901,5902],maxSessions:1,greetingTimeoutMs:8000,
    attendedHostKey:KEY,
  }),/single.target|attended/i);
});
test('attended host proof refuses a correct marker with a wrong HMAC', {timeout:9000}, async()=>{
  const f=await createFixture(socket=>{
    socket.write('UVNC1');
    let incoming=Buffer.alloc(0);
    socket.on('data',chunk=>{
      incoming=Buffer.concat([incoming,chunk]);
      if(incoming.length<32)return;
      socket.write(Buffer.concat([Buffer.alloc(32,0x08),Buffer.from('RFB 003.008\n')]));
      socket.removeAllListeners('data');
    });
  });
  try{
    const result=await upgrade(f.url,f.upstream.address().port);
    assert.doesNotMatch(result.header,/101 Switching Protocols/);
  } finally {await f.close()}
});