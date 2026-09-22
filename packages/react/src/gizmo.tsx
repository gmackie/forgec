import {
  Component,
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Workspace, type ForgeCall } from "./workspace.js";
import type { UiDescriptor } from "./descriptor.js";

/** A purpose-built UI, supplied by the host application at build time. */
export interface GizmoDefinition {
  id: string;
  title: string;
  description: string;
  supports: (descriptor: UiDescriptor) => boolean;
  component: ComponentType<GizmoProps>;
}
export interface GizmoProps {
  descriptor: UiDescriptor;
  /** Uses the same authenticated runtime and concurrency guards as generated forms. */
  call: ForgeCall;
  /** Mark local edits AND pending writes so navigation cannot discard them. */
  onDirtyChange: (dirty: boolean) => void;
  /** Open the standard forms for an optional resource route. */
  openForms: (route?: string) => void;
}

class GizmoBoundary extends Component<
  { children: ReactNode; onError: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? (
      <p role="alert">
        This gizmo could not open. You can still use Data &amp; forms.
      </p>
    ) : (
      this.props.children
    );
  }
}

/** Both surfaces are projections of one deployed contract. No scripts are loaded from it. */
export function GizmoWorkspace({
  descriptor,
  call,
  gizmos,
  onDirtyChange,
}: {
  descriptor: UiDescriptor;
  call: ForgeCall;
  gizmos: readonly GizmoDefinition[];
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [view, setView] = useState("forms");
  const [route, setRoute] = useState<string | undefined>();
  const [dirty, setDirty] = useState(false);
  const available = gizmos.filter((g) => g.supports(descriptor));
  const selected = available.find((g) => `gizmo:${g.id}` === view);
  const reportDirty = useCallback(
    (value: boolean) => {
      setDirty(value);
      onDirtyChange?.(value);
    },
    [onDirtyChange],
  );
  const recover = useCallback(() => reportDirty(false), [reportDirty]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const openForms = useCallback(
    (nextRoute?: string) => {
      if (dirty) return;
      if (nextRoute && !descriptor.resources.some((r) => r.route === nextRoute))
        return;
      setRoute(nextRoute);
      setView("forms");
    },
    [dirty, descriptor],
  );
  const Custom = selected?.component;
  return (
    <div className="forge-gizmo-workspace">
      <nav className="gizmo-view-switch" aria-label="Use experience">
        <button
          type="button"
          aria-pressed={view === "forms"}
          disabled={dirty && view !== "forms"}
          onClick={() => openForms(route)}
        >
          Data &amp; forms
        </button>
        <button
          type="button"
          aria-pressed={view !== "forms"}
          disabled={dirty}
          onClick={() => {
            if (!dirty) setView("gizmos");
          }}
        >
          Gizmos
        </button>
      </nav>
      {dirty && (
        <p role="status">
          Save or discard your changes before switching experiences or
          environments.
        </p>
      )}
      {view === "forms" ? (
        <>
          <p className="gizmo-surface-description">
            Standard tables and forms for the application's records. These stay
            available alongside custom gizmos.
          </p>
          <Workspace
            descriptor={descriptor}
            call={call}
            {...(route ? { initialRoute: route } : {})}
            onDirtyChange={reportDirty}
          />
        </>
      ) : selected && Custom ? (
        <section aria-label={selected.title} className="gizmo-detail">
          <header>
            <div>
              <p className="eyebrow">GIZMO</p>
              <h3>{selected.title}</h3>
              <p>{selected.description}</p>
            </div>
            <button
              type="button"
              disabled={dirty}
              onClick={() => setView("gizmos")}
            >
              All gizmos
            </button>
          </header>
          <GizmoBoundary key={selected.id} onError={recover}>
            <Custom
              descriptor={descriptor}
              call={call}
              openForms={openForms}
              onDirtyChange={reportDirty}
            />
          </GizmoBoundary>
        </section>
      ) : (
        <section aria-label="Available gizmos" className="gizmo-launcher">
          <h3>A workspace for the task at hand</h3>
          <p>
            Open a purpose-built experience, or use Data &amp; forms for the
            standard record tools.
          </p>
          {available.length ? (
            <div className="gizmo-cards">
              {available.map((g) => (
                <button
                  type="button"
                  key={g.id}
                  onClick={() => setView(`gizmo:${g.id}`)}
                >
                  <strong>{g.title}</strong>
                  <span>{g.description}</span>
                  <span className="gizmo-open">Open gizmo →</span>
                </button>
              ))}
            </div>
          ) : (
            <p>
              No gizmos are installed for this application. Data &amp; forms are
              ready to use.
            </p>
          )}
        </section>
      )}
    </div>
  );
}
