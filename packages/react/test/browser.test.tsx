import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RecordBrowser } from "../src/browser.js";
import type { ForgeCall, UiDescriptor } from "../src/workspace.js";
import bundle from "../../../conformance/fixtures/acme.app.json";
afterEach(cleanup);
const descriptor = bundle.ui as UiDescriptor;
it("browses pages, searches locally, and opens details without write operations", async () => {
  const call = vi.fn<ForgeCall>(async (_,input) => ({ok:true,value: (input as any).cursor ? {items:[{id:"2",name:"Grace",code:"G"}],next:null} : {items:[{id:"1",name:"Ada",code:"A",tier:"gold"}],next:"second"}}));
  render(<RecordBrowser descriptor={descriptor} call={call} initialRoute="customers" />);
  expect(await screen.findByRole("button",{name:"View Ada"})).toBeVisible();
  expect(screen.queryByRole("button",{name:"Add row"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"View Ada"}));
  expect(screen.getByRole("region",{name:"Record details"})).toHaveTextContent("Gold");
  fireEvent.change(screen.getByLabelText("Search this page"),{target:{value:"missing"}});
  expect(screen.getByText("No matching records on this page.")).toBeVisible();
  expect(call).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText("Search this page"),{target:{value:""}});
  fireEvent.click(screen.getByRole("button",{name:"Next page"}));
  expect(await screen.findByRole("button",{name:"View Grace"})).toBeVisible();
  expect(screen.queryByRole("region",{name:"Record details"})).toBeNull();
  expect(call).toHaveBeenLastCalledWith("@acme/commerce/_/Customer.list.all",{params:{},limit:50,cursor:"second"});
  fireEvent.click(screen.getByRole("button",{name:"Previous page"}));
  expect(await screen.findByRole("button",{name:"View Ada"})).toBeVisible();
  expect(call.mock.calls.every(([op])=>op.includes(".list."))).toBe(true);
});
it("discards stale requests and does not retain rows after a failed refresh", async () => {
  let resolve!: (result:any)=>void;
  const call = vi.fn<ForgeCall>().mockImplementationOnce(()=>new Promise((r)=>{resolve=r;})).mockResolvedValue({ok:false,code:"Forbidden",status:403,problem:{code:"Forbidden"}});
  render(<RecordBrowser descriptor={descriptor} call={call} initialRoute="customers" />);
  fireEvent.click(screen.getByRole("button",{name:"Orders"}));
  resolve({ok:true,value:{items:[{id:"1",name:"Stale"}],next:null}});
  await waitFor(()=>expect(screen.queryByText("Stale")).toBeNull());
  expect(screen.queryByRole("button",{name:"View Stale"})).toBeNull();
});
it("shows no-query collections without inventing a list operation", () => {
  const call = vi.fn<ForgeCall>();
  const first = {...descriptor.resources[0]!,lists:[]};
  render(<RecordBrowser descriptor={{...descriptor,resources:[first]}} call={call}/>);
  expect(screen.getByRole("status")).toHaveTextContent("No browse query is exposed");
  expect(call).not.toHaveBeenCalled();
});
it("clears previous records on a denied refresh and allows a retry", async () => {
  const call=vi.fn<ForgeCall>().mockResolvedValueOnce({ok:true,value:{items:[{id:"1",name:"Ada"}],next:null}})
    .mockResolvedValueOnce({ok:false,code:"Forbidden",status:403,problem:{code:"Forbidden",detail:"Access changed"}})
    .mockResolvedValue({ok:true,value:{items:[{id:"2",name:"Grace"}],next:null}});
  render(<RecordBrowser descriptor={descriptor} call={call} initialRoute="customers"/>);
  await screen.findByRole("button",{name:"View Ada"});
  fireEvent.click(screen.getByRole("button",{name:"Refresh records"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("Access changed");
  expect(screen.queryByRole("button",{name:"View Ada"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Refresh records"}));
  expect(await screen.findByRole("button",{name:"View Grace"})).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});
