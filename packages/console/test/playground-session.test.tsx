// @vitest-environment jsdom
import React from "react";
import { afterEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { FunctionPlayground } from "../web/operations.js";
afterEach(cleanup);
function setup() {
 let revision = "deployment-1";
 const calls: any[] = [];
 const api = vi.fn(async (path: string, method?: string, body?: any) => {
  if(path === '/runtime/targets') return {targets:[{id:'workers',name:'Workers production'}]};
  if(path.endsWith('/catalog')) return {buildHash:'build-1',deploymentRevision:revision,observedAt:'2026-09-27T00:00:00Z',operations:['Estimate','Validate'].map(id=>({id,summary:id,method:'POST',path:'/'+id,sample:{hours:1}}))};
  calls.push(body);return {status:200,durationMs:12,at:'2026-09-27T00:00:00Z',outcome:{kind:'ok',value:{total:300}}};
 });
 render(<FunctionPlayground api={api as any} />);
 return {calls,changeRevision:()=>{revision='deployment-2'}};
}
it('preserves independent input, purpose, and request key drafts when switching functions',async()=>{
 setup();await screen.findByRole('button',{name:/Estimate.*POST/});
 fireEvent.change(screen.getByLabelText('Sample input'),{target:{value:'{"hours":2}'}});
 fireEvent.change(screen.getByLabelText('Purpose'),{target:{value:'support'}});
 fireEvent.change(screen.getByLabelText('Idempotency key'),{target:{value:'request-1'}});
 fireEvent.click(screen.getByRole('button',{name:/Validate.*POST/}));
 expect(screen.getByLabelText('Purpose')).toHaveValue('');
 fireEvent.click(screen.getByRole('button',{name:/Estimate.*POST/}));
 expect(screen.getByLabelText('Sample input')).toHaveValue('{"hours":2}');
 expect(screen.getByLabelText('Purpose')).toHaveValue('support');
 expect(screen.getByLabelText('Idempotency key')).toHaveValue('request-1');
});
it('restores the original request without invoking and blocks replay after deployment changes',async()=>{
 const {calls,changeRevision}=setup();await screen.findByRole('button',{name:/Estimate.*POST/});
 fireEvent.change(screen.getByLabelText('Sample input'),{target:{value:'{"hours":2}'}});
 fireEvent.change(screen.getByLabelText('Idempotency key'),{target:{value:'request-1'}});
 fireEvent.click(screen.getByRole('button',{name:'Invoke function'}));
 await screen.findByRole('button',{name:'Restore input'});
 expect(calls[0]).toMatchObject({input:{hours:2},deploymentRevision:'deployment-1',idempotencyKey:'request-1'});
 fireEvent.click(screen.getByRole('button',{name:/Validate.*POST/}));
 fireEvent.click(screen.getByRole('button',{name:/Estimate.*Workers production/}));
 expect(screen.getByLabelText('Original request')).toHaveTextContent('{"hours":2}');
 fireEvent.click(screen.getByRole('button',{name:'Restore input'}));
 expect(screen.getByLabelText('Sample input')).toHaveValue('{"hours":2}');
 expect(screen.getByLabelText('Idempotency key')).toHaveValue('');
 expect(calls).toHaveLength(1);
 changeRevision();fireEvent.click(screen.getByRole('button',{name:'Reload contract'}));
 await waitFor(()=>expect(screen.queryByText('Discovering runtime contracts…')).not.toBeInTheDocument());
 fireEvent.click(screen.getByRole('button',{name:/Estimate.*Workers production/}));
 expect(screen.getByRole('button',{name:'Restore input'})).toBeDisabled();
 fireEvent.click(screen.getByRole('button',{name:'Clear history'}));
 expect(screen.queryByText('Recent invocations')).not.toBeInTheDocument();
});
