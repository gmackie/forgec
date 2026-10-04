import billing from "./samples/billing.openapi.json";
import directory from "./samples/directory.openapi.json";

export interface OpenApiSample {
  id: string;
  package: string;
  title: string;
  host: string;
  summary: string;
  text: string;
}

export const openApiSamples: OpenApiSample[] = [
  {
    id: "billing",
    package: "@external/billing",
    title: "Vendor Billing",
    host: "billing.vendor.example",
    summary: "Create an invoice and read it back.",
    text: JSON.stringify(billing),
  },
  {
    id: "directory",
    package: "@external/directory",
    title: "Support Directory",
    host: "directory.vendor.example",
    summary: "Look up a contact by the vendor's id.",
    text: JSON.stringify(directory),
  },
];
