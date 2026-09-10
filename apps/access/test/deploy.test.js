import { expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { assertPrivateBucket, parseOAuthFile, parseSecretJSON, validateSecrets, withSecretsFile } from '../scripts/deploy.js';

const secrets={GITHUB_CLIENT_ID:'fixture-id',GITHUB_CLIENT_SECRET:'fixture-secret',RESEND_API_KEY:'re_fixture'};

test('deploy validates credential fields without including values in errors',()=>{
  expect(validateSecrets(secrets)).toEqual(secrets);
  expect(parseOAuthFile('GITHUB_CLIENT_ID="fixture-id"\nGITHUB_CLIENT_SECRET=fixture-secret')).toEqual({GITHUB_CLIENT_ID:'fixture-id',GITHUB_CLIENT_SECRET:'fixture-secret'});
  for(const value of [{...secrets,GITHUB_CLIENT_ID:''},{...secrets,GITHUB_CLIENT_SECRET:'ghp_private'},{...secrets,UNEXPECTED:'private'}]) expect(()=>validateSecrets(value)).toThrow();
  expect(()=>parseOAuthFile('private-bare-token')).toThrow('OAuth file needs');
  expect(()=>parseOAuthFile('GITHUB_CLIENT_ID=a\nGITHUB_CLIENT_ID=b')).toThrow();
  expect(()=>parseSecretJSON('{"secret":"do-not-echo')).toThrow('Invalid credential JSON.');
});

test('R2 storage fails closed if public access is enabled or privacy cannot be verified',async()=>{
  for(const [managed,custom,ok] of [[{enabled:false},{domains:[]},true],[{enabled:true},{domains:[]},false],[{enabled:false},{domains:[{enabled:false}]},false],[{},{domains:[]},false],[{enabled:false},{},false]]) {
    const check=assertPrivateBucket(async path=>path.endsWith('managed')?managed:custom);
    if(ok) await check; else await expect(check).rejects.toThrow('private R2');
  }
});

test('deployment secrets are private temporary files and removed even when deploy fails',async()=>{
  let target;
  await expect(withSecretsFile(secrets,async path=>{
    target=path;expect(statSync(path).mode&0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path,'utf8'))).toEqual(secrets);
    throw new Error('deployment failed');
  })).rejects.toThrow('deployment failed');
  expect(existsSync(target)).toBe(false);
});
