// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import bundle from "../../../conformance/fixtures/acme.app.json";
import { foundationExplorer, FoundationExplorer } from "../web/gizmos/foundation-explorer.js";
import type { UiDescriptor } from "@forgegraph/react";
afterEach(cleanup);
it("offers only deployed foundation collections and opens their generated records",()=>{
 const descriptor = bundle.ui as UiDescriptor;
 expect(foundationExplorer.supports(descriptor)).toBe(false);
 const resource = {...descriptor.resources[0]!,id:"@forgegraph/foundation/artifact/_/Artifact",plural:"Artifacts",route:"artifacts"};
 const composed={...descriptor,resources:[...descriptor.resources,resource]};
 expect(foundationExplorer.supports(composed)).toBe(true);
 const openForms=vi.fn(); const call=vi.fn();
 render(<FoundationExplorer descriptor={composed} openForms={openForms} call={call} onDirtyChange={()=>{}}/>);
 fireEvent.click(screen.getByRole("button",{name:/Artifacts/}));
 expect(openForms).toHaveBeenCalledWith("artifacts");
 expect(screen.queryByRole("button",{name:/Customers/})).toBeNull();
 expect(call).not.toHaveBeenCalled();
});
