import { useCallback, useEffect, useRef, useState } from "react";
import {
  Canvas,
  FabricObject,
  FabricImage,
  Textbox,
  Rect,
  Circle,
  Triangle,
  ActiveSelection,
} from "fabric";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Bold,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle as CircleIcon,
  Copy,
  Crop,
  Download,
  Eye,
  EyeOff,
  FileImage,
  FilePlus2,
  FileUp,
  Grip,
  HelpCircle,
  ImagePlus,
  Layers,
  Lock,
  Maximize,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  RotateCw,
  Save,
  Shapes,
  Sparkles,
  Square,
  Trash2,
  Type,
  Undo2,
  Unlock,
  Upload,
  X,
} from "lucide-react";
import { importFile } from "./lib/importer";
import {
  protectProportions,
  resizeKind,
  resizeProps,
  straightenText,
} from "./lib/proportions";
import {
  downloadProject,
  loadDraft,
  readProject,
  saveDraft,
  type GraphicProject,
  type ProjectPage,
} from "./lib/project";
import { exportPng, exportSvg, exportPptx } from "./lib/exporter";

FabricObject.ownDefaults.originX = "left";
FabricObject.ownDefaults.originY = "top";
FabricObject.customProperties = [
  "name",
  "selectable",
  "evented",
  "lockMovementX",
  "lockMovementY",
  "lockScalingX",
  "lockScalingY",
  "lockRotation",
  "hasControls",
];
Object.assign(FabricObject.ownDefaults, {
  cornerColor: "#6555df",
  borderColor: "#6555df",
  cornerStrokeColor: "#ffffff",
  transparentCorners: false,
  cornerSize: 10,
  padding: 3,
});
type NamedObject = FabricObject & { name?: string };
const uid = () => crypto.randomUUID();
const blankPage = (): ProjectPage => ({
  id: uid(),
  name: "Untitled page",
  width: 960,
  height: 600,
  json: { version: "7.4.0", objects: [], background: "#ffffff" },
});
const initialPage = blankPage();
const initialProject: GraphicProject = {
  version: 1,
  name: "Untitled composition",
  pages: [initialPage],
  activePageId: initialPage.id,
};
const palettes = [
  "#282733",
  "#6555df",
  "#ff8c68",
  "#efbd51",
  "#8da892",
  "#ffffff",
];

function IconButton({
  title,
  children,
  onClick,
  disabled = false,
  active = false,
}: {
  title: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`btn btn-icon ${active ? "active" : ""}`}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

export default function App() {
  const canvasEl = useRef<HTMLCanvasElement>(null);
  const areaEl = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<Canvas | null>(null);
  const projectRef = useRef<GraphicProject>(initialProject);
  const [project, setProject] = useState(initialProject);
  const [selected, setSelected] = useState<NamedObject | null>(null);
  const [objects, setObjects] = useState<NamedObject[]>([]);
  const [revision, setRevision] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState<{
    message: string;
    progress: number;
  } | null>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(
    null,
  );
  const [saved, setSaved] = useState("Saved on this device");
  const [menu, setMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [crop, setCrop] = useState<number[] | null>(null);
  const [language, setLanguage] = useState("eng");
  const [textMode, setTextMode] = useState<"conservative" | "image-only">(
    () => {
      try {
        return localStorage.getItem("graphic-text-mode") === "image-only"
          ? "image-only"
          : "conservative";
      } catch {
        return "conservative";
      }
    },
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const projectInput = useRef<HTMLInputElement>(null);
  const suppress = useRef(false);
  const busyRef = useRef(false);
  const history = useRef<string[]>([]);
  const future = useRef<string[]>([]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(false);
  const notice = useCallback(
    (text: string, error = false) => setToast({ text, error }),
    [],
  );
  const activePage =
    project.pages.find((p) => p.id === project.activePageId) ??
    project.pages[0];

  const refresh = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    setSelected((c.getActiveObject() as NamedObject) ?? null);
    setObjects([...c.getObjects()] as NamedObject[]);
    setRevision((v) => v + 1);
  }, []);
  const snapshot = useCallback((): GraphicProject => {
    const c = canvasRef.current;
    const p = projectRef.current;
    if (!c) return p;
    const json = c.toJSON() as Record<string, unknown>;
    return {
      ...p,
      pages: p.pages.map((page) =>
        page.id === p.activePageId ? { ...page, json } : page,
      ),
    };
  }, []);
  const persist = useCallback(
    (p: GraphicProject) => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      setSaved("Saving…");
      autosaveTimer.current = setTimeout(() => {
        saveDraft(p)
          .then(() => {
            if (mounted.current) setSaved("Saved on this device");
          })
          .catch((error) => {
            if (mounted.current) {
              setSaved("Draft not saved · download a project");
              notice(
                error instanceof Error
                  ? error.message
                  : "Draft storage is unavailable.",
                true,
              );
            }
          });
      }, 400);
    },
    [notice],
  );
  const commit = useCallback(() => {
    if (suppress.current) return;
    const p = snapshot();
    projectRef.current = p;
    setProject(p);
    const serialized = JSON.stringify(p);
    if (history.current.at(-1) !== serialized) {
      history.current.push(serialized);
      let memory = history.current.reduce(
        (bytes, value) => bytes + value.length,
        0,
      );
      while (
        history.current.length > 1 &&
        (history.current.length > 30 || memory > 60_000_000)
      ) {
        memory -= history.current.shift()!.length;
      }
      future.current = [];
    }
    persist(p);
    refresh();
  }, [snapshot, persist, refresh]);
  const fit = useCallback((requested?: number) => {
    const c = canvasRef.current;
    const area = areaEl.current;
    if (!c || !area) return;
    const p = projectRef.current.pages.find(
      (p) => p.id === projectRef.current.activePageId,
    )!;
    const factor =
      requested ??
      Math.min(
        (area.clientWidth - 88) / p.width,
        (area.clientHeight - 88) / p.height,
        1,
      );
    const z = Math.max(0.1, Math.min(3, factor));
    c.setDimensions({ width: p.width * z, height: p.height * z });
    c.setViewportTransform([z, 0, 0, z, 0, 0]);
    c.requestRenderAll();
    setZoom(z);
  }, []);
  const showProject = useCallback(
    async (p: GraphicProject, resetHistory = false) => {
      const c = canvasRef.current;
      if (!c) return;
      suppress.current = true;
      try {
        c.discardActiveObject();
        await c.loadFromJSON(
          p.pages.find((page) => page.id === p.activePageId)!.json,
        );
        // Drafts saved before proportional text fitting may contain stretched text.
        for (const object of c.getObjects()) {
          straightenText(object);
          protectProportions(object);
        }
        projectRef.current = p;
        setProject(p);
        fit();
        refresh();
        if (resetHistory) {
          history.current = [JSON.stringify(p)];
          future.current = [];
        }
        persist(p);
      } finally {
        suppress.current = false;
      }
    },
    [fit, persist, refresh],
  );

  useEffect(() => {
    try {
      localStorage.setItem("graphic-text-mode", textMode);
    } catch {
      /* Editing also works without preference storage. */
    }
  }, [textMode]);

  useEffect(() => {
    mounted.current = true;
    const c = new Canvas(canvasEl.current!, {
      backgroundColor: "#ffffff",
      preserveObjectStacking: true,
      selectionColor: "#6555df20",
      selectionBorderColor: "#6555df",
      // Holding Shift must not unlock one-directional stretching of text or images.
      uniScaleKey: null,
    });
    canvasRef.current = c;
    c.on("object:added", ({ target }) => protectProportions(target));
    const onChange = () => commit();
    c.on("object:modified", onChange);
    c.on("text:changed", onChange);
    c.on("selection:created", refresh);
    c.on("selection:updated", refresh);
    c.on("selection:cleared", refresh);
    let cancelled = false;
    busyRef.current = true;
    loadDraft()
      .then(async (draft) => {
        if (cancelled) return;
        await showProject(draft ?? initialProject, true);
      })
      .catch(() => {
        if (!cancelled) {
          history.current = [JSON.stringify(initialProject)];
          fit();
          notice("Start a composition. Draft recovery was unavailable.", true);
        }
      })
      .finally(() => {
        if (!cancelled) busyRef.current = false;
      });
    const observer = new ResizeObserver(() => fit());
    if (areaEl.current) observer.observe(areaEl.current);
    return () => {
      cancelled = true;
      mounted.current = false;
      observer.disconnect();
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      canvasRef.current = null;
      void c.dispose();
    };
  }, [commit, fit, notice, refresh, showProject]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 7500);
    return () => clearTimeout(t);
  }, [toast]);

  const run = useCallback(
    async (action: () => Promise<void>, message = "Working…") => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy({ message, progress: 0 });
      try {
        await action();
      } catch (error) {
        notice(
          error instanceof Error
            ? error.message
            : "Something went wrong. Please try again.",
          true,
        );
      } finally {
        busyRef.current = false;
        setBusy(null);
      }
    },
    [notice],
  );
  const importFiles = useCallback(
    (files: File[]) => {
      if (files.length === 0) return;
      void run(async () => {
        if (files.length > 10)
          throw new Error("Please import up to 10 files at a time.");
        const imported: ProjectPage[] = [];
        const warnings = new Set<string>();
        for (let index = 0; index < files.length; index++) {
          const pages = await importFile(
            files[index],
            (message, progress) =>
              setBusy({ message, progress: (index + progress) / files.length }),
            { ocrLanguage: language, textMode },
          );
          for (const page of pages) {
            imported.push({
              id: page.id,
              name: page.name,
              width: page.width,
              height: page.height,
              json: {
                version: "7.4.0",
                background: "#ffffff",
                objects: page.objects.map((o) => o.toObject(["name"])),
              },
            });
            page.warnings.forEach((w) => warnings.add(w));
          }
        }
        if (!imported.length) throw new Error("No pages could be imported.");
        const p = snapshot();
        const existing = p.pages.filter(
          (page) =>
            !(
              p.pages.length === 1 &&
              ((page.json.objects as unknown[]) ?? []).length === 0
            ),
        );
        if (existing.length + imported.length > 40)
          throw new Error(
            "A project supports up to 40 pages. Start a new project for more pages.",
          );
        await showProject({
          ...p,
          pages: [...existing, ...imported],
          activePageId: imported[0].id,
        });
        commit();
        notice(
          `${imported.length} page${imported.length === 1 ? "" : "s"} ready to edit.${warnings.size ? " " + [...warnings].join(" ") : ""}`,
        );
      }, "Preparing your files…");
    },
    [run, language, textMode, snapshot, showProject, commit, notice],
  );
  const update = useCallback(
    (props: Record<string, unknown>) => {
      if (busyRef.current) return;
      const c = canvasRef.current;
      const o = c?.getActiveObject();
      if (!c || !o) return;
      o.set(props);
      o.setCoords();
      c.requestRenderAll();
      commit();
    },
    [commit],
  );
  const removeSelected = useCallback(() => {
    const c = canvasRef.current;
    if (!c || busyRef.current) return;
    const selected = c.getActiveObjects();
    c.discardActiveObject();
    c.remove(...selected);
    c.requestRenderAll();
    commit();
  }, [commit]);
  const duplicate = useCallback(() => {
    const c = canvasRef.current;
    const o = c?.getActiveObject();
    if (!c || !o || busyRef.current) return;
    void run(async () => {
      const copy = await o.clone(["name"]);
      c.discardActiveObject();
      copy.set({ left: copy.left + 24, top: copy.top + 24 });
      if (copy instanceof ActiveSelection) {
        copy.canvas = c;
        copy.forEachObject((obj) => c.add(obj));
      } else c.add(copy);
      c.setActiveObject(copy);
      c.requestRenderAll();
      commit();
    }, "Duplicating…");
  }, [commit, run]);
  const undo = useCallback(
    (redo = false) => {
      if (busyRef.current) return;
      if (
        (redo && future.current.length === 0) ||
        (!redo && history.current.length < 2)
      )
        return;
      void run(async () => {
        let value: string;
        if (redo) {
          value = future.current.pop()!;
          history.current.push(value);
        } else {
          future.current.push(history.current.pop()!);
          value = history.current.at(-1)!;
        }
        await showProject(JSON.parse(value));
      });
    },
    [run, showProject],
  );
  const addObject = useCallback(
    (type: "text" | "rect" | "circle" | "triangle") => {
      const c = canvasRef.current;
      if (!c || busyRef.current) return;
      const p = projectRef.current.pages.find(
        (p) => p.id === projectRef.current.activePageId,
      )!;
      const props = {
        left: p.width * 0.3,
        top: p.height * 0.3,
        fill: "#6555df",
      };
      const o =
        type === "text"
          ? new Textbox("Make it yours.", {
              ...props,
              fill: "#282733",
              width: 360,
              fontFamily: "Arial",
              fontSize: 42,
            })
          : type === "circle"
            ? new Circle({ ...props, radius: 70 })
            : type === "triangle"
              ? new Triangle({ ...props, width: 160, height: 140 })
              : new Rect({ ...props, width: 200, height: 130, rx: 8, ry: 8 });
      (o as NamedObject).name =
        type === "text"
          ? "Text"
          : type === "rect"
            ? "Rectangle"
            : type === "circle"
              ? "Circle"
              : "Triangle";
      c.add(o);
      c.setActiveObject(o);
      c.requestRenderAll();
      commit();
    },
    [commit],
  );
  useEffect(() => {
    const paste = (event: ClipboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,[contenteditable=true]",
        ) ||
        (canvasRef.current?.getActiveObject() as Textbox)?.isEditing
      )
        return;
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        event.preventDefault();
        importFiles(files);
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        (event.target as HTMLElement)?.closest(
          "input,textarea,select,[contenteditable=true]",
        ) ||
        (canvasRef.current?.getActiveObject() as Textbox)?.isEditing ||
        busyRef.current ||
        crop ||
        help
      )
        return;
      const cmd = event.ctrlKey || event.metaKey;
      if (cmd && event.key.toLowerCase() === "z") {
        event.preventDefault();
        undo(event.shiftKey);
      } else if (cmd && event.key.toLowerCase() === "y") {
        event.preventDefault();
        undo(true);
      } else if (cmd && event.key.toLowerCase() === "d") {
        event.preventDefault();
        duplicate();
      } else if (cmd && event.key.toLowerCase() === "s") {
        event.preventDefault();
        try {
          downloadProject(snapshot());
        } catch (error) {
          notice(
            error instanceof Error
              ? error.message
              : "Could not save the project.",
            true,
          );
        }
      } else if (cmd && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const c = canvasRef.current!;
        c.setActiveObject(
          new ActiveSelection(
            c.getObjects().filter((o) => o.selectable),
            { canvas: c },
          ),
        );
        c.requestRenderAll();
        refresh();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        removeSelected();
      } else if (event.key === "Escape") {
        canvasRef.current?.discardActiveObject();
        canvasRef.current?.requestRenderAll();
        refresh();
        setMenu(false);
      } else if (
        ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
      ) {
        const o = canvasRef.current?.getActiveObject();
        if (!o) return;
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        update({
          left:
            o.left +
            (event.key === "ArrowLeft"
              ? -step
              : event.key === "ArrowRight"
                ? step
                : 0),
          top:
            o.top +
            (event.key === "ArrowUp"
              ? -step
              : event.key === "ArrowDown"
                ? step
                : 0),
        });
      }
    };
    window.addEventListener("paste", paste);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("paste", paste);
      window.removeEventListener("keydown", key);
    };
  }, [
    importFiles,
    undo,
    duplicate,
    snapshot,
    refresh,
    removeSelected,
    update,
    crop,
    help,
    notice,
  ]);

  const switchPage = (id: string) => {
    if (id === project.activePageId) return;
    void run(async () => {
      await showProject({ ...snapshot(), activePageId: id });
      commit();
    });
  };
  const newPage = () =>
    void run(async () => {
      const p = snapshot();
      if (p.pages.length >= 40)
        throw new Error("This project already has 40 pages.");
      const page = blankPage();
      page.name = `Page ${p.pages.length + 1}`;
      await showProject({
        ...p,
        pages: [...p.pages, page],
        activePageId: page.id,
      });
      commit();
    });
  const deletePage = () =>
    void run(async () => {
      const p = snapshot();
      const pages = p.pages.filter((v) => v.id !== p.activePageId);
      if (!pages.length) pages.push(blankPage());
      await showProject({ ...p, pages, activePageId: pages[0].id });
      commit();
    });
  const reorder = (direction: "up" | "down") => {
    const c = canvasRef.current;
    if (!c || !selected) return;
    if (direction === "up") c.bringObjectForward(selected);
    else c.sendObjectBackwards(selected);
    c.requestRenderAll();
    commit();
  };
  const saveExport = (format: "png" | "svg" | "pptx" | "project") => {
    setMenu(false);
    void run(async () => {
      const p = snapshot();
      const c = canvasRef.current!;
      if (format === "project") {
        downloadProject(p);
        return;
      }
      if (format === "pptx") {
        await exportPptx(p);
        return;
      }
      const dims = { width: c.width, height: c.height };
      const transform = [...c.viewportTransform] as typeof c.viewportTransform;
      try {
        c.discardActiveObject();
        c.setDimensions({ width: activePage.width, height: activePage.height });
        c.setViewportTransform([1, 0, 0, 1, 0, 0]);
        c.renderAll();
        if (format === "png") exportPng(c, p.name);
        else exportSvg(c, p.name);
      } finally {
        c.setDimensions(dims);
        c.setViewportTransform(transform);
        c.requestRenderAll();
        refresh();
      }
    }, "Preparing your download…");
  };
  const applyCrop = () => {
    if (!(selected instanceof FabricImage) || !crop) return;
    const [left, top, right, bottom] = crop;
    if (left + right >= 95 || top + bottom >= 95) {
      notice("Keep at least 5% of the image in each direction.", true);
      return;
    }
    const dx = (selected.width * left) / 100,
      dy = (selected.height * top) / 100;
    const angle = (selected.angle * Math.PI) / 180;
    update({
      cropX: selected.cropX + dx,
      cropY: selected.cropY + dy,
      width: selected.width * (1 - (left + right) / 100),
      height: selected.height * (1 - (top + bottom) / 100),
      left:
        selected.left +
        dx * selected.scaleX * Math.cos(angle) -
        dy * selected.scaleY * Math.sin(angle),
      top:
        selected.top +
        dx * selected.scaleX * Math.sin(angle) +
        dy * selected.scaleY * Math.cos(angle),
    });
    setCrop(null);
  };
  const demo = () =>
    void run(async () => {
      const c = canvasRef.current!;
      const p = blankPage();
      p.name = "A little room to play";
      const current = snapshot();
      await showProject({
        ...current,
        pages: current.pages.map((page) =>
          page.id === current.activePageId ? p : page,
        ),
        activePageId: p.id,
      });
      const shapes: NamedObject[] = [
        new Rect({
          left: 0,
          top: 0,
          width: 960,
          height: 600,
          fill: "#f3eee4",
          selectable: false,
          evented: false,
        }),
        new Circle({ left: 625, top: 108, radius: 130, fill: "#e89574" }),
        new Rect({
          left: 680,
          top: 267,
          width: 172,
          height: 216,
          fill: "#879985",
          angle: -12,
        }),
        new Circle({ left: 570, top: 348, radius: 56, fill: "#eabd55" }),
        new Textbox("A LITTLE ROOM TO PLAY", {
          left: 65,
          top: 75,
          width: 500,
          fontSize: 15,
          charSpacing: 180,
          fontFamily: "Arial",
          fill: "#666255",
        }),
        new Textbox("Ideas take\nshape here.", {
          left: 62,
          top: 145,
          width: 540,
          fontSize: 72,
          fontWeight: "bold",
          lineHeight: 1.04,
          fontFamily: "Georgia",
          fill: "#302f2a",
        }),
        new Textbox(
          "Move a shape. Change a word.\nMake something entirely your own.",
          {
            left: 68,
            top: 353,
            width: 460,
            fontSize: 22,
            lineHeight: 1.35,
            fontFamily: "Arial",
            fill: "#666255",
          },
        ),
        new Textbox("GRAPHIC  /  YOUR NEXT BLANK CANVAS", {
          left: 68,
          top: 524,
          width: 540,
          fontSize: 12,
          charSpacing: 90,
          fontFamily: "Arial",
          fill: "#666255",
        }),
      ];
      shapes.forEach((o, i) => {
        o.name =
          i === 0
            ? "Page background"
            : o instanceof Textbox
              ? o.text.split("\n")[0]
              : `Shape ${i}`;
        c.add(o);
      });
      c.requestRenderAll();
      commit();
    });

  const numberField = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    min?: number,
    max?: number,
  ) => (
    <label className="field">
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        step={1}
        min={min}
        max={max}
        value={Math.round(value * 10) / 10}
        onChange={(e) => {
          if (e.target.value === "") return;
          const n = Number(e.target.value);
          if (Number.isFinite(n))
            onChange(Math.max(min ?? -100000, Math.min(max ?? 100000, n)));
        }}
      />
    </label>
  );
  const isText = selected instanceof Textbox;
  const fill = typeof selected?.fill === "string" ? selected.fill : "#282733";
  void revision;
  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        importFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(e) => e.preventDefault()}
          aria-label="Graphic home"
        >
          <span className="brand-mark">
            <Shapes size={23} />
          </span>
          <span className="brand-name">
            graphic<span>.</span>
          </span>
        </a>
        <div className="document-title">
          <input
            aria-label="Project name"
            value={project.name}
            maxLength={120}
            onChange={(e) => {
              const p = { ...projectRef.current, name: e.target.value };
              projectRef.current = p;
              setProject(p);
            }}
            onBlur={() => {
              projectRef.current = {
                ...projectRef.current,
                name: projectRef.current.name.trim() || "Untitled composition",
              };
              commit();
            }}
          />
          <span className="saved-status">
            <Check size={12} />
            {saved}
          </span>
        </div>
        <div className="topbar-actions">
          <IconButton title="Help and shortcuts" onClick={() => setHelp(true)}>
            <HelpCircle size={19} />
          </IconButton>
          <button
            className="btn btn-quiet"
            onClick={() => projectInput.current?.click()}
          >
            <FileUp size={16} />
            Open project
          </button>
          <button
            className="btn btn-quiet"
            onClick={() => saveExport("project")}
          >
            <Save size={16} />
            Save project
          </button>
          <div className="export-wrap">
            <button
              className="btn btn-primary"
              onClick={() => setMenu(!menu)}
              aria-expanded={menu}
            >
              <Download size={16} />
              Export
              <ChevronDown size={14} />
            </button>
            {menu && (
              <>
                <button
                  className="menu-dismiss"
                  aria-label="Close export menu"
                  onClick={() => setMenu(false)}
                />
                <div className="dropdown">
                  <button onClick={() => saveExport("png")}>
                    PNG image <span>Current page</span>
                  </button>
                  <button onClick={() => saveExport("svg")}>
                    SVG artwork <span>Current page</span>
                  </button>
                  <button onClick={() => saveExport("pptx")}>
                    PowerPoint <span>All pages · editable</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span className="eyebrow">YOUR CREATIVE WORKSPACE</span>
            <h1 className="intro-title">
              Every image.
              <br />A new beginning.
            </h1>
            <p className="muted">
              Turn what you have into
              <br />
              something you can make your own.
            </p>
          </div>
          <button
            className="import-card"
            onClick={() => fileInput.current?.click()}
            disabled={!!busy}
          >
            <span className="import-icon">
              <Upload size={22} />
            </span>
            <span className="import-title">Import a file</span>
            <span className="import-types">Images & PDFs</span>
            <span className="import-paste">
              or paste an image with <kbd>Ctrl V</kbd>
            </span>
          </button>
          <label className="field language-field">
            <span>Text conversion</span>
            <select
              aria-label="Text conversion mode"
              value={textMode}
              onChange={(e) =>
                setTextMode(e.target.value as "conservative" | "image-only")
              }
            >
              <option value="conservative">Careful text conversion</option>
              <option value="image-only">Images only · keep original</option>
            </select>
          </label>
          <p className="conversion-hint">
            {textMode === "image-only"
              ? "Keep each image or PDF page intact. No text recognition. You can still move, resize, rotate, and crop it."
              : "Only clear, confident text becomes editable. Boxed graphics, icons, and uncertain text stay as images."}
            <span>Applies to the next import or paste.</span>
          </p>
          <label className="field language-field">
            <span>Text recognition</span>
            <select
              aria-label="Text recognition language"
              value={language}
              disabled={textMode === "image-only"}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="eng">English</option>
              <option value="eng+chi_sim">中文 + English</option>
              <option value="eng+chi_tra">繁體中文 + English</option>
              <option value="eng+spa">Español + English</option>
            </select>
          </label>
          <div className="divider-label">
            <span>OR START CREATING</span>
          </div>
          <div className="tool-grid">
            <button className="tool-card" onClick={() => addObject("text")}>
              <Type size={20} />
              <span>Add text</span>
            </button>
            <button className="tool-card" onClick={() => addObject("rect")}>
              <Square size={19} />
              <span>Rectangle</span>
            </button>
            <button className="tool-card" onClick={() => addObject("circle")}>
              <CircleIcon size={19} />
              <span>Circle</span>
            </button>
            <button className="tool-card" onClick={() => addObject("triangle")}>
              <Shapes size={19} />
              <span>Triangle</span>
            </button>
          </div>
          <div className="section-label">
            <span>
              PAGES{" "}
              <span className="count">
                {project.pages.length.toString().padStart(2, "0")}
              </span>
            </span>
            <IconButton title="Add blank page" onClick={newPage}>
              <Plus size={16} />
            </IconButton>
          </div>
          <div className="pages-list">
            {project.pages.map((page, i) => (
              <button
                key={page.id}
                className={`page-card ${page.id === project.activePageId ? "active" : ""}`}
                onClick={() => switchPage(page.id)}
              >
                <span className="page-thumb">
                  <FileImage size={21} />
                </span>
                <span className="page-meta">
                  <strong>{page.name}</strong>
                  <small>
                    {page.width} × {page.height}
                  </small>
                </span>
                <span className="page-number">
                  {(i + 1).toString().padStart(2, "0")}
                </span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <span className="privacy-dot" />
            Your files stay in your browser.
          </div>
        </aside>
        <main className="main-area">
          <div className="canvas-toolbar">
            <div className="toolbar-group">
              <span className="tool-active">
                <MousePointer2 size={17} />
                <span>Select</span>
              </span>
              <span className="toolbar-divider" />
              <IconButton
                title="Undo (Ctrl Z)"
                onClick={() => undo()}
                disabled={history.current.length < 2}
              >
                <Undo2 size={18} />
              </IconButton>
              <IconButton
                title="Redo (Ctrl Shift Z)"
                onClick={() => undo(true)}
                disabled={!future.current.length}
              >
                <Redo2 size={18} />
              </IconButton>
            </div>
            <div className="toolbar-group">
              <IconButton title="Zoom out" onClick={() => fit(zoom - 0.1)}>
                <Minus size={16} />
              </IconButton>
              <button
                className="zoom-value btn btn-quiet"
                onClick={() => fit()}
                title="Fit page"
              >
                {Math.round(zoom * 100)}%
              </button>
              <IconButton title="Zoom in" onClick={() => fit(zoom + 0.1)}>
                <Plus size={16} />
              </IconButton>
              <span className="toolbar-divider" />
              <IconButton title="Fit page" onClick={() => fit()}>
                <Maximize size={17} />
              </IconButton>
            </div>
          </div>
          <div className="canvas-area" ref={areaEl}>
            <div className="canvas-shell">
              <canvas ref={canvasEl} aria-label="Design canvas" />
              {objects.length === 0 && (
                <div className="empty-overlay">
                  <div className="empty-symbol">
                    <ImagePlus size={31} />
                    <span>
                      <Sparkles size={15} />
                    </span>
                  </div>
                  <span className="eyebrow">A FRESH PERSPECTIVE</span>
                  <h2 className="empty-title">
                    From static to
                    <br />
                    <em>something more.</em>
                  </h2>
                  <p className="empty-copy">
                    Drop an image or PDF here.
                    <br />
                    Make the text, shapes, and details your own.
                  </p>
                  <button
                    className="btn btn-primary"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Plus size={16} />
                    Bring something in
                  </button>
                  <button className="demo-link" onClick={demo}>
                    Or try an editable example <ChevronRight size={14} />
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="canvas-footer">
            <span>
              {activePage.name} <span className="footer-dot">·</span>{" "}
              {activePage.width} × {activePage.height} px
            </span>
            <span>
              {objects.length} elements <span className="footer-dot">·</span>{" "}
              Double-click text to edit
            </span>
          </div>
        </main>
        <aside className="inspector">
          <div className="inspector-title">
            <h2>Properties</h2>
            <span className="selection-badge">
              {selected
                ? selected instanceof ActiveSelection
                  ? "Multiple"
                  : isText
                    ? "Text"
                    : selected instanceof FabricImage
                      ? "Image"
                      : "Shape"
                : "Page"}
            </span>
          </div>
          {selected ? (
            <>
              <section className="property-section">
                <div className="section-label">TRANSFORM</div>
                <div className="field-grid">
                  {numberField("X", selected.left, (n) => update({ left: n }))}
                  {numberField("Y", selected.top, (n) => update({ top: n }))}
                  {numberField(
                    "Width",
                    selected.width * selected.scaleX,
                    (n) =>
                      update(
                        resizeProps(resizeKind(selected), selected, "width", n),
                      ),
                    1,
                    10000,
                  )}
                  {numberField(
                    "Height",
                    selected.height * selected.scaleY,
                    (n) =>
                      update(
                        resizeProps(
                          resizeKind(selected),
                          selected,
                          "height",
                          n,
                        ),
                      ),
                    1,
                    10000,
                  )}
                  {numberField(
                    "Rotation",
                    selected.angle,
                    (n) => update({ angle: n }),
                    -360,
                    360,
                  )}
                  {numberField(
                    "Opacity %",
                    selected.opacity * 100,
                    (n) => update({ opacity: n / 100 }),
                    0,
                    100,
                  )}
                </div>
                <div className="segmented">
                  <IconButton
                    title="Rotate 90 degrees"
                    onClick={() =>
                      update({ angle: (selected.angle + 90) % 360 })
                    }
                  >
                    <RotateCw size={16} />
                  </IconButton>
                  <IconButton
                    title="Duplicate element (Ctrl D)"
                    onClick={duplicate}
                  >
                    <Copy size={16} />
                  </IconButton>
                  <IconButton
                    title="Bring forward"
                    onClick={() => reorder("up")}
                  >
                    <ArrowUpFromLine size={16} />
                  </IconButton>
                  <IconButton
                    title="Send backward"
                    onClick={() => reorder("down")}
                  >
                    <ArrowDownToLine size={16} />
                  </IconButton>
                  <IconButton title="Delete element" onClick={removeSelected}>
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              </section>
              {isText && (
                <section className="property-section">
                  <div className="section-label">TEXT</div>
                  <label className="text-editor">
                    <span className="sr-only">Text content</span>
                    <textarea
                      aria-label="Text content"
                      rows={3}
                      value={(selected as Textbox).text}
                      onChange={(e) => update({ text: e.target.value })}
                    />
                  </label>
                  <div className="field-grid">
                    <label className="field">
                      <span>Font</span>
                      <select
                        aria-label="Font family"
                        value={(selected as Textbox).fontFamily}
                        onChange={(e) => update({ fontFamily: e.target.value })}
                      >
                        <option>Arial</option>
                        <option>Georgia</option>
                        <option>Verdana</option>
                        <option>Times New Roman</option>
                        <option>Courier New</option>
                      </select>
                    </label>
                    {numberField(
                      "Font size",
                      (selected as Textbox).fontSize,
                      (n) => update({ fontSize: n }),
                      6,
                      400,
                    )}
                  </div>
                  <div className="segmented">
                    <IconButton
                      title="Bold"
                      active={(selected as Textbox).fontWeight === "bold"}
                      onClick={() =>
                        update({
                          fontWeight:
                            (selected as Textbox).fontWeight === "bold"
                              ? "normal"
                              : "bold",
                        })
                      }
                    >
                      <Bold size={16} />
                    </IconButton>
                    {(["left", "center", "right"] as const).map((align) => (
                      <button
                        key={align}
                        className={`btn btn-quiet ${(selected as Textbox).textAlign === align ? "active" : ""}`}
                        onClick={() => update({ textAlign: align })}
                      >
                        {align}
                      </button>
                    ))}
                  </div>
                </section>
              )}
              {!(selected instanceof FabricImage) &&
                !(selected instanceof ActiveSelection) && (
                  <section className="property-section">
                    <div className="section-label">
                      {isText ? "TEXT COLOR" : "FILL COLOR"}
                    </div>
                    <label className="color-field">
                      <input
                        type="color"
                        aria-label="Element color"
                        value={/^#[0-9a-f]{6}$/i.test(fill) ? fill : "#282733"}
                        onChange={(e) => update({ fill: e.target.value })}
                      />
                      <span>{fill.toUpperCase()}</span>
                    </label>
                    <div className="swatches">
                      {palettes.map((color) => (
                        <button
                          key={color}
                          className="swatch"
                          style={{ background: color }}
                          title={color}
                          aria-label={`Set color ${color}`}
                          onClick={() => update({ fill: color })}
                        />
                      ))}
                    </div>
                  </section>
                )}
              {selected instanceof FabricImage && (
                <section className="property-section">
                  <button
                    className="btn crop-button"
                    onClick={() => setCrop([0, 0, 0, 0])}
                  >
                    <Crop size={16} />
                    Crop image
                  </button>
                  <p className="muted small">
                    Trim the edges. Use Undo to restore the original crop.
                  </p>
                </section>
              )}
            </>
          ) : (
            <>
              <section className="property-section">
                <div className="section-label">CANVAS</div>
                <div className="field-grid">
                  {numberField(
                    "Page width",
                    activePage.width,
                    (n) => {
                      const p = {
                        ...projectRef.current,
                        pages: projectRef.current.pages.map((v) =>
                          v.id === activePage.id ? { ...v, width: n } : v,
                        ),
                      };
                      projectRef.current = p;
                      fit();
                      commit();
                    },
                    100,
                    4000,
                  )}
                  {numberField(
                    "Page height",
                    activePage.height,
                    (n) => {
                      const p = {
                        ...projectRef.current,
                        pages: projectRef.current.pages.map((v) =>
                          v.id === activePage.id ? { ...v, height: n } : v,
                        ),
                      };
                      projectRef.current = p;
                      fit();
                      commit();
                    },
                    100,
                    4000,
                  )}
                </div>
                <label className="color-field">
                  <input
                    type="color"
                    aria-label="Page background color"
                    value={
                      typeof canvasRef.current?.backgroundColor === "string"
                        ? canvasRef.current.backgroundColor
                        : "#ffffff"
                    }
                    onChange={(e) => {
                      canvasRef.current!.backgroundColor = e.target.value;
                      canvasRef.current!.requestRenderAll();
                      commit();
                    }}
                  />
                  <span>Background</span>
                </label>
                <button
                  className="btn btn-quiet delete-page"
                  onClick={deletePage}
                >
                  <Trash2 size={14} />
                  Delete page
                </button>
              </section>
              <div className="hint-card">
                <MousePointer2 size={20} />
                <strong>A little nudge, a big change.</strong>
                <p>
                  Select any element to adjust its size, color, and position.
                </p>
              </div>
            </>
          )}
          <div className="layers-heading section-label">
            <span>
              <Layers size={15} />
              LAYERS
            </span>
            <span className="count">{objects.length}</span>
          </div>
          <div className="layer-list">
            {[...objects].reverse().map((o, index) => (
              <div
                key={objects.length - index}
                className={`layer-row ${selected === o ? "active" : ""}`}
              >
                <button
                  className="layer-select"
                  onClick={() => {
                    const c = canvasRef.current!;
                    if (!o.selectable) {
                      notice("Unlock this layer to edit it.");
                      return;
                    }
                    c.setActiveObject(o);
                    c.requestRenderAll();
                    refresh();
                  }}
                >
                  <span className="layer-icon">
                    {o instanceof Textbox ? (
                      <Type size={15} />
                    ) : o instanceof FabricImage ? (
                      <FileImage size={15} />
                    ) : (
                      <Square size={15} />
                    )}
                  </span>
                  <span className="layer-name">
                    {o instanceof Textbox
                      ? o.text.slice(0, 32)
                      : (o.name ?? o.type)}
                  </span>
                </button>
                <div className="layer-actions">
                  <button
                    title={o.visible ? "Hide layer" : "Show layer"}
                    aria-label={o.visible ? "Hide layer" : "Show layer"}
                    onClick={() => {
                      o.visible = !o.visible;
                      canvasRef.current!.discardActiveObject();
                      canvasRef.current!.requestRenderAll();
                      commit();
                    }}
                  >
                    {o.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                  </button>
                  <button
                    title={o.selectable ? "Lock layer" : "Unlock layer"}
                    aria-label={o.selectable ? "Lock layer" : "Unlock layer"}
                    onClick={() => {
                      const unlocked = !o.selectable;
                      o.set({
                        selectable: unlocked,
                        evented: unlocked,
                        lockMovementX: !unlocked,
                        lockMovementY: !unlocked,
                        lockScalingX: !unlocked,
                        lockScalingY: !unlocked,
                        lockRotation: !unlocked,
                        hasControls: unlocked,
                      });
                      canvasRef.current!.discardActiveObject();
                      canvasRef.current!.requestRenderAll();
                      commit();
                    }}
                  >
                    {o.selectable ? <Unlock size={13} /> : <Lock size={13} />}
                  </button>
                </div>
              </div>
            ))}
            {!objects.length && (
              <p className="empty-layers">
                Your layers will appear here.
                <br />
                Good things start with a blank page.
              </p>
            )}
          </div>
        </aside>
      </div>
      <footer className="statusbar">
        <span>
          <span className="privacy-dot" />
          LOCAL WORKSPACE
        </span>
        <span>Less recreating. More creating.</span>
        <button onClick={() => setHelp(true)}>
          Quick guide <HelpCircle size={13} />
        </button>
      </footer>
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        aria-label="Import images or PDFs"
        accept="image/png,image/jpeg,image/webp,image/bmp,application/pdf,.pdf"
        multiple
        onChange={(e) => {
          importFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
      <input
        ref={projectInput}
        className="sr-only"
        type="file"
        aria-label="Open Graphic project"
        accept=".graphic,.json"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file)
            void run(async () => {
              const p = await readProject(file);
              await showProject(p);
              commit();
              notice("Project opened.");
            }, "Opening project…");
        }}
      />
      {toast && (
        <div
          className={`toast ${toast.error ? "toast-error" : ""}`}
          role={toast.error ? "alert" : "status"}
        >
          <span>{toast.text}</span>
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss notification"
          >
            <X size={16} />
          </button>
        </div>
      )}
      {busy && (
        <div className="progress-overlay" role="status" aria-live="polite">
          <div className="progress-card">
            <div className="import-icon">
              <Sparkles size={25} />
            </div>
            <h2>{busy.message}</h2>
            <div className="progress-track">
              <div
                className="progress-fill"
                style={{
                  width: `${Math.max(4, Math.min(100, busy.progress * 100))}%`,
                }}
              />
            </div>
            <p>
              Your files stay on this device.
              <br />
              The first text conversion may take a moment.
            </p>
          </div>
        </div>
      )}
      {crop && (
        <div className="modal-backdrop">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="crop-title"
          >
            <div className="modal-header">
              <h2 id="crop-title">Crop image</h2>
              <IconButton title="Close crop" onClick={() => setCrop(null)}>
                <X size={18} />
              </IconButton>
            </div>
            <p className="muted">Choose how much to trim from each edge.</p>
            <div className="crop-grid">
              {["Left %", "Top %", "Right %", "Bottom %"].map((label, i) => (
                <div key={label}>
                  {numberField(
                    label,
                    crop[i],
                    (n) => setCrop(crop.map((v, j) => (i === j ? n : v))),
                    0,
                    90,
                  )}
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setCrop(null)}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={applyCrop}>
                Apply crop
              </button>
            </div>
          </div>
        </div>
      )}
      {help && (
        <div className="modal-backdrop">
          <div
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <div className="modal-header">
              <h2 id="help-title">A little guide to Graphic.</h2>
              <IconButton title="Close guide" onClick={() => setHelp(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="help-list">
              <p>
                <strong>Bring it in.</strong> Paste a screenshot, drop an image,
                or import a PDF. Each PDF page becomes a canvas. Up to 20 PDF
                pages per file, 40 project pages, and 25 MB per file.
              </p>
              <p>
                <strong>Make it yours.</strong> Double-click text to edit. Drag
                elements to move, corner handles to resize, and the top handle
                to rotate. Use the Properties panel for exact values and image
                cropping.
              </p>
              <p>
                <strong>About conversion.</strong> Careful text conversion only
                extracts confident text from plain areas. Text inside detected
                graphic boxes, icons, and uncertain words keep their original
                pixels. Detection is approximate; review the result. Choose
                Images only before importing or pasting to keep each image or
                PDF page intact with no text conversion at all. This also skips
                selectable PDF text extraction. You can still move, resize,
                rotate, and crop the image, or add text yourself. Changing the
                mode applies to future imports, not pages already converted.
              </p>
              <p>
                <strong>Take it with you.</strong> Save a Graphic project to
                keep editing later. Export PNG, SVG, or an editable PowerPoint.
                Drafts are saved in this browser. OCR engine and language files
                download on first use; your imported documents are not sent to a
                server.
              </p>
              <p>
                <strong>Shortcuts.</strong> Ctrl/⌘ Z: undo · Shift Ctrl/⌘ Z:
                redo · Ctrl/⌘ D: duplicate · Ctrl/⌘ S: save · Delete: remove ·
                Arrow keys: nudge · Shift + arrows: nudge 10 pixels.
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
