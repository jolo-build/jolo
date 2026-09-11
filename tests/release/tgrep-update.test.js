import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, targets, updateFile } from '../../scripts/update-tgrep.js';

const digest = text => createHash('sha256').update(text).digest('hex');
const repository = 'https://github.com/microsoft/tgrep';
const pin = { version:'1.0.5', repository, assets:Object.fromEntries(Object.entries(targets).map(([platform,target])=>[platform,{target,sha256:digest(target)}])) };
const directories=[];
afterEach(()=>{for(const path of directories.splice(0))rmSync(path,{recursive:true,force:true});});
function fixture(version='1.0.6') {
  const bodies=new Map(),calls=[];
  const assets=Object.values(targets).map(target=>{
    const name=`tgrep-v${version}-${target}.tar.gz`,body=Buffer.from(target);
    const url=`${repository}/releases/download/v${version}/${name}`;bodies.set(url,body);
    return {name,size:body.length,digest:`sha256:${digest(body)}`,browser_download_url:url};
  });
  const checksums=Buffer.from(assets.map(asset=>`${asset.digest.slice(7)}  ${asset.name}`).join('\n')+'\n');
  const url=`${repository}/releases/download/v${version}/checksums.txt`;
  bodies.set(url,checksums);assets.push({name:'checksums.txt',size:checksums.length,digest:`sha256:${digest(checksums)}`,browser_download_url:url});
  const release={tag_name:`v${version}`,draft:false,prerelease:false,assets};
  const fetchImpl=async(url,init)=>{calls.push({url,init});return url.startsWith('https://api.github.com/')?Response.json(release):new Response(bodies.get(url));};
  return {release,bodies,calls,fetchImpl};
}

test('a new stable release verifies all four archives and keeps API credentials off download requests',async()=>{
  const f=fixture();const result=await checkRelease(pin,{fetchImpl:f.fetchImpl,token:'fixture-token'});
  expect(result.changed).toBe(true);expect(result.pin.version).toBe('1.0.6');expect(result.pin.assets).toEqual(pin.assets);
  expect(f.calls).toHaveLength(6);expect(f.calls[0].init.headers.Authorization).toBe('Bearer fixture-token');
  expect(f.calls.slice(1).every(call=>!call.init.headers)).toBe(true);
});

test('same version is a byte-preserving no-op; verification checks the pinned release without changing it',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'jolo-tgrep-update-'));directories.push(directory);
  const path=join(directory,'release.json'),original=JSON.stringify(pin);writeFileSync(path,original);
  const f=fixture('1.0.5');expect((await updateFile(path,{fetchImpl:f.fetchImpl})).changed).toBe(false);
  expect(f.calls).toHaveLength(1);expect(readFileSync(path,'utf8')).toBe(original);
  expect((await updateFile(path,{fetchImpl:f.fetchImpl,verify:true})).changed).toBe(false);
  expect(f.calls.at(1).url).toEndWith('/tags/v1.0.5');expect(readFileSync(path,'utf8')).toBe(original);
});

test('older, prerelease, draft, and malformed release tags are rejected',async()=>{
  for(const version of ['0.9.9','1.0.6-beta.1','1.0.6\nmalformed']) {
    const f=fixture(version);await expect(checkRelease(pin,{fetchImpl:f.fetchImpl})).rejects.toThrow();
  }
  for(const key of ['draft','prerelease']) {const f=fixture();f.release[key]=true;await expect(checkRelease(pin,{fetchImpl:f.fetchImpl})).rejects.toThrow();}
});

test('missing assets, alternate download origins, and contradictory published digests fail closed',async()=>{
  for(const mutate of [f=>f.release.assets.pop(),f=>f.release.assets.push(f.release.assets[0]),f=>f.release.assets[0].browser_download_url='https://example.com/file',f=>f.release.assets[0].digest=`sha256:${'a'.repeat(64)}`,f=>f.release.assets[0].size=128*1024*1024]) {
    const f=fixture();mutate(f);await expect(checkRelease(pin,{fetchImpl:f.fetchImpl})).rejects.toThrow();
  }
});

test('an archive mismatch leaves the original pin intact; successful checks replace it',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'jolo-tgrep-update-'));directories.push(directory);
  const path=join(directory,'release.json'),original=JSON.stringify(pin);writeFileSync(path,original);
  const broken=fixture();broken.bodies.set(broken.release.assets.at(3).browser_download_url,Buffer.from('tampered archive'));
  await expect(updateFile(path,{fetchImpl:broken.fetchImpl})).rejects.toThrow('digest mismatch');
  expect(readFileSync(path,'utf8')).toBe(original);
  await updateFile(path,{fetchImpl:fixture().fetchImpl});expect(JSON.parse(readFileSync(path,'utf8')).version).toBe('1.0.6');
});

test('verification detects changed pins and rejects HTTP errors',async()=>{
  const modified=structuredClone(pin);modified.assets['linux-x64'].sha256='f'.repeat(64);
  await expect(checkRelease(modified,{fetchImpl:fixture('1.0.5').fetchImpl,verify:true})).rejects.toThrow('Pinned checksum changed');
  await expect(checkRelease(pin,{fetchImpl:async()=>new Response('rate limit',{status:403})})).rejects.toThrow('HTTP 403');
});
