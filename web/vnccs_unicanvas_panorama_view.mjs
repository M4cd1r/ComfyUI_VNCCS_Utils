// Panorama view session (#33): the globe button of the panorama layer opens it, the camera
// controls and the canvas move the view live inside it, and it ends with Save (one history
// entry), Cancel (the view from before the session) or stays open after Reset (initial view).
import { PANORAMA_DEFAULT_CAMERA, PANORAMA_VIEW_HISTORY_KIND, panoramaView, samePanoramaView } from "./vnccs_unicanvas_panorama.mjs";

export class PanoramaViewSession {
  constructor(widget) {
    this.widget = widget;
    this.document = null;
    this.start = null;
  }

  get active() { return Boolean(this.document); }

  /** Whether the session edits `doc` (a replaced or closed document ends it). */
  isFor(doc) { return Boolean(doc) && this.document === doc; }

  enter(doc) {
    if (!doc) return false;
    if (this.document === doc) return true;
    this.close();
    if (!doc.canRotate()) return false;
    doc.flushCamera();
    this.document = doc;
    this.start = panoramaView(doc.settings);
    return true;
  }

  /** Move to `view` at once (Reset, Cancel): one full-quality projection, no history. */
  moveTo(view) {
    const doc = this.document;
    if (!doc || !doc.beginCamera()) return false;
    doc.setCamera(view);
    doc.endCamera();
    return true;
  }

  reset() { return this.moveTo(PANORAMA_DEFAULT_CAMERA); }

  save() {
    const doc = this.document;
    if (!doc) return null;
    doc.flushCamera();
    const before = this.start, after = panoramaView(doc.settings);
    this.close();
    if (samePanoramaView(before, after)) return null;
    const entry = { kind: PANORAMA_VIEW_HISTORY_KIND, before, after };
    this.widget.pushHistoryEntry(entry);
    return entry;
  }

  cancel() {
    const doc = this.document;
    if (!doc) return false;
    doc.flushCamera();
    // A view that cannot be restored right now (an edit in progress) keeps the session open.
    if (!samePanoramaView(this.start, panoramaView(doc.settings)) && !this.moveTo(this.start)) return false;
    this.close();
    return true;
  }

  close() {
    this.document = null;
    this.start = null;
  }
}
