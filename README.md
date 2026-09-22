# Graphic

A browser-based workspace for turning pasted images, uploaded images, and PDF pages into editable compositions.

## Run locally

Use Node.js 22.12+ (Node 24 recommended):

```sh
npm ci
npm run dev
```

Open the localhost URL printed by Vite. To create a production build, run `npm run build`; serve the `dist/` folder with any static web server. `npm run preview` serves the build locally. The relative asset paths support hosting at a subdirectory such as `/graphic/`. Opening `index.html` directly through a `file://` URL will not work because the conversion engines use web workers.

## GitHub Pages deployment

The published app is [Graphic](https://polymathlc.github.io/graphic/). The repository's Pages publishing source must be **GitHub Actions** (`build_type: workflow`). The `Verify Graphic` workflow runs unit tests, builds the production bundle, and runs browser tests. After those checks pass for a push to `main`, it uploads the generated `dist/` directory and deploys that exact artifact to the `github-pages` environment. Pull requests run the same checks with read-only repository permissions and do not publish a site.

Vite uses relative asset URLs (`base: "./"`) so the generated JavaScript, styles, and worker files load beneath `/graphic/`. Publishing the repository root instead serves the source `index.html`, whose `/src/main.tsx` entry cannot run as a production site. For deployment troubleshooting, check the **Deploy GitHub Pages** job and verify the served HTML references `./assets/` files. See GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## What you can do

- Paste clipboard images with Ctrl/⌘ V, drop files onto the workspace, or use **Import a file**.
- Choose **Careful text conversion** (default) to convert only confident text in plain areas. Text in detected graphic boxes, icons, and uncertain words keeps its original image pixels. PDF text is extracted directly when available; scanned pages use OCR.
- Choose **Images only · keep original** before importing or pasting to preserve each complete image/PDF page as one movable, resizable, rotatable, croppable image. This skips all OCR and native PDF text extraction; no text is erased or replaced. You can still add text manually.
- Separate disconnected graphics on a near-flat background into independent image layers. Every imported page also has a locked reconstructed background.
- Move, resize, rotate, crop images, change text, fonts and colors, set opacity, reorder, hide and lock layers, and undo/redo.
- Work with multiple pages and switch between them without losing edits.
- Save/open `.graphic.json` projects. A draft also saves automatically in this browser using IndexedDB.
- Export the current page as PNG or SVG, or all pages as a PowerPoint with editable text and basic shapes and independently movable pictures.

Text recognition supports English, Simplified Chinese + English, Traditional Chinese + English, and Spanish + English. The editor includes an editable sample composition.

The conversion mode applies to the next upload, drop, or paste. Changing it does not alter pages already imported. Reimport the original file to apply another mode.

## Conversion quality and limits

Flattened pixels do not contain the original design objects. Careful conversion performs best-effort reconstruction, not exact reversal of a screenshot. It checks individual word confidence and graphic context before replacing any pixels. Rejected words and icons are not erased. Low-contrast bordered cards and filled graphics are protected where detected. These checks are deliberately conservative but cannot identify every graphic or recognition error. Choose Images only whenever the original appearance matters more than editable text.

Accepted text boxes use browser font substitutes, and spacing can differ. Text removal fills accepted word regions with sampled nearby colors; textured backgrounds, overlapping artwork, complex diagrams, and touching shapes can still require manual touch-ups. Reconstructed graphic pieces are raster images rather than editable vector paths. On a PDF page with selectable text, text embedded inside pictures stays in the artwork.

Files must be at most **25 MB**; PDFs may contain up to **20 pages**. Images and PDF pages are rendered with a maximum edge of **1,800 pixels**. Projects support up to **40 pages**, subject to browser memory and storage. Protected PDFs must be unlocked before import. Images need a browser-supported raster format. Corrupt/unsupported files display an error. If the OCR engine cannot load, the image is still editable and the app reports that text recognition failed.

PowerPoint uses the first page's slide proportions; other page sizes fit within those dimensions. Text remains editable, but its fonts and wrapping can vary in PowerPoint. Complex effects are exported as separate pictures, with fallback details in slide notes. Image crops are baked into exported picture pixels. Save the Graphic project to retain the original source image for undo/cropping in this editor.

## Privacy and persistence

Imported documents and OCR processing stay in the browser. No application backend, account, or API key is required. On first use, OCR downloads its runtime and selected language files, and PDF.js may download supporting fonts, character maps, and WebAssembly files. These asset requests contact their public CDNs; document bytes are not uploaded. Offline conversion requires those assets to be cached and is not guaranteed.

Automatic drafts are specific to this browser and device. Clearing site data removes them. Download a project file for a portable backup. Project imports validate shape types, dimensions and embedded raster sources; external image URLs and unsafe paint references are rejected.

## Keyboard shortcuts

| Shortcut           | Action                      |
| ------------------ | --------------------------- |
| Ctrl/⌘ V           | Paste image                 |
| Ctrl/⌘ Z           | Undo                        |
| Ctrl/⌘ Shift Z     | Redo                        |
| Ctrl/⌘ D           | Duplicate selected elements |
| Ctrl/⌘ S           | Download editable project   |
| Ctrl/⌘ A           | Select unlocked elements    |
| Delete / Backspace | Delete selected elements    |
| Arrow keys         | Move by one pixel           |
| Shift + arrow keys | Move by ten pixels          |

Shortcuts defer to text editing when a text input is focused.

## Validation

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
```

On local Windows, browser tests use installed Chrome. In CI, they use Playwright Chromium. Tests cover segmentation, project validation, actual image OCR, clipboard image paste, native and scanned PDF conversion, cropping, transforms, history, draft/project round-trips, and PNG/SVG/PowerPoint downloads. OCR integration tests need internet access to download recognition assets.

Built with React, TypeScript, Fabric.js, PDF.js, Tesseract.js, and PptxGenJS. Core documentation: [Fabric.js](https://fabricjs.com/docs/), [PDF.js](https://mozilla.github.io/pdf.js/), [Tesseract.js](https://github.com/naptha/tesseract.js), and [PptxGenJS](https://gitbrent.github.io/PptxGenJS/).
