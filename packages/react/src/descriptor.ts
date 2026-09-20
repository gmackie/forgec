/** Types for the compiled UI descriptor (`ui/1`) in the app bundle. */
export interface UiOption { value: string; label: string }
export interface UiReference { resource: string; route: string; titleField: string; lookup: string; lookupParams: string[]; find?: string }
export interface UiField {
  name: string; label: string; widget: string; required: boolean;
  editableOnCreate: boolean; editableOnUpdate: boolean; sortable: boolean;
  options?: UiOption[]; reference?: UiReference; minLength?: number; maxLength?: number; currency?: string; doc?: string;
}
export interface UiList { name: string; op: string; params: string[]; label: string }
export interface UiFind { name: string; op: string; params: string[] }
export interface UiAction { name: string; label: string; op: string; from: string[]; to: string; inputFields: UiField[] }
export interface UiResource {
  id: string; name: string; kind: string; label: string; plural: string; route: string; titleField: string;
  fields: UiField[]; tableColumns: string[]; lists: UiList[]; finds: UiFind[]; actions: UiAction[];
  softDelete: boolean; versioned: boolean; content?: { mediaTypes: string[]; maxBytes: number };
}
export interface UiDescriptor { version: string; package: string; resources: UiResource[] }
