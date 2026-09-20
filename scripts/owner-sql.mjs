/** Generates an enrollment SQL file locally. Never outputs passwords or hashes to logs. */
import {randomBytes,pbkdf2Sync} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
export function ownerSql(username,password,{rotate=false}={}){
 if(!/^[a-zA-Z0-9._-]{1,80}$/.test(username)||password.length<12||password.length>128)throw new Error('Username: 1–80 ASCII letters/digits/._-; password: 12–128 chars.');
 const salt=randomBytes(16);const hash=['pbkdf2-sha256',100000,salt.toString('base64url'),pbkdf2Sync(password,salt,100000,32,'sha256').toString('base64url')].join('$');
 return rotate?`UPDATE users SET username='${username}',password_hash='${hash}',auth_version=auth_version+1 WHERE id='owner';\nDELETE FROM sessions;\nDELETE FROM service_tokens;\n`:`INSERT INTO users (id,username,password_hash) VALUES ('owner','${username}','${hash}');\n`;
}
if(process.argv[1]?.endsWith('owner-sql.mjs')){
 const path=process.argv[2];if(!path)throw new Error('Usage: MEMORY_USERNAME=... MEMORY_PASSWORD=... node scripts/owner-sql.mjs /private/path/owner.sql [--rotate]');
 await writeFile(path,ownerSql(process.env.MEMORY_USERNAME??'',process.env.MEMORY_PASSWORD??'',{rotate:process.argv.includes('--rotate')}),{mode:0o600,flag:'wx'});
 console.log('Owner SQL written with mode 0600. Apply with wrangler, then delete this private file.');
}
