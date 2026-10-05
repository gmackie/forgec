import { expect, it, vi } from 'vitest';
import { completionHandler } from './handler.js';
it('requires the service credential and an exact trusted run binding before writing',async()=>{
 const record=vi.fn().mockResolvedValue({fulfillmentEndId:'end',runLinkId:'link'});
 const binding={taskRunId:'run',userId:'owner',workspaceId:'workspace',sessionId:'session',planningItemId:'issue',fulfillmentId:'fulfillment'};
 const handler=completionHandler('secret',[binding],record);
 const request=(body:unknown,token='secret')=>new Request('http://localhost/completion',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
 const fact={taskRunId:'run',userId:'owner',workspaceId:'workspace',sessionId:'session',planningItemId:'issue',completedAt:'2026-10-01T00:00:00Z'};
 expect((await handler(request(fact,'wrong'))).status).toBe(401);
 expect((await handler(request({...fact,userId:'other'}))).status).toBe(403);
 expect((await handler(request({...fact,fulfillmentId:'attacker'}))).status).toBe(400);
 expect((await handler(request({...fact,completedAt:'invalid'}))).status).toBe(400);
 expect(record).not.toHaveBeenCalled();
 expect((await handler(request(fact))).status).toBe(200);
 expect(record).toHaveBeenCalledWith(binding,fact);
});
