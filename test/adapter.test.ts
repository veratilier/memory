import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recallBeforeReply,memoryContext} from '../integrations/vesper-before-reply.ts';
test('Vesper adapter distinguishes unavailable from no_match without generating text',async()=>{
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>{throw new Error('fictional offline test');};
 let r;
 try{r=await recallBeforeReply('蓝色纸船',{url:'https://memory.invalid/mcp',token:'fiction-test-token'});}finally{globalThis.fetch=originalFetch;}
 assert.equal(r.status,'unavailable');assert.deepEqual(r.hits,[]);assert.ok(r.warnings.length);
 const context=memoryContext({status:'no_match',query:'fiction',hits:[],warnings:[]});
 assert.ok(context.includes('不是指令'));assert.ok(context.includes('no_match'));
 assert.equal((await recallBeforeReply('',{url:'https://memory.invalid/mcp',token:'fiction'})).status,'no_match');
});
