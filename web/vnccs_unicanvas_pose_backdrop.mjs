/**
 * Flat 2D backdrop and depth limit for the embedded UniCanvas pose editor.
 *
 * A pose layer ends up as a 2D image composited over the layers below it, so the
 * embedded Pose Studio shows only the mannequin under a free camera: no skydome,
 * grid or capture frame, and the layers below stay visible through the transparent
 * viewport. Those layers act as a flat backdrop - a camera-facing plane with no
 * depth that always fills the view just behind the deepest mannequin.
 *
 * The plane only writes depth: its pixels are the 2D layers already drawn under the
 * viewport, so drawing them again in WebGL would double them under the pose layer's
 * opacity and blend mode. Characters are never moved automatically (no clamp): the
 * user places them freely in 3D, and the plane just re-settles behind the deepest
 * one whenever the camera changes.
 */

// How far behind the orbit target the backdrop sits, in multiples of the character radius.
export const POSE_BACKDROP_OFFSET_RADII = 1.25;
// Fallback character radius (Pose Studio world units) before a mesh is measured.
const FALLBACK_RADIUS = 10;

/**
 * Distance from the camera to the backdrop plane: the orbit target distance plus an
 * offset behind the target, so orbiting and dollying keep the plane behind the mannequin.
 */
export function poseBackdropDistance(cameraToTarget, characterRadius, offsetRadii = POSE_BACKDROP_OFFSET_RADII) {
  const radius = Number.isFinite(characterRadius) && characterRadius > 0 ? characterRadius : FALLBACK_RADIUS;
  return Math.max(1e-3, Number(cameraToTarget) || 0) + radius * offsetRadii;
}

/** Plane size that exactly fills a perspective frustum at `distance`. */
export function poseBackdropSize(distance, fovDegrees, aspect, zoom = 1) {
  const height = (2 * distance * Math.tan(((Number(fovDegrees) || 45) * Math.PI) / 360)) / Math.max(0.1, Number(zoom) || 1);
  return { width: height * (Number(aspect) || 1), height };
}

export class UniCanvasPoseBackdrop {
  constructor(editor) {
    this.editor = editor;
    this.viewer = editor.studio.viewer;
    this.THREE = this.viewer.THREE;
    this.bounds = null;
    const THREE = this.THREE;
    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      // Depth only: occludes whatever would sit behind the backdrop without painting it.
      new THREE.MeshBasicMaterial({ colorWrite: false, side: THREE.DoubleSide }),
    );
    this.plane.name = "VNCCS_UniCanvasPoseBackdrop";
    this.plane.frustumCulled = false;
    this.plane.renderOrder = -1000;
    const camera = this.viewer.camera;
    if (!camera.parent) this.viewer.scene.add(camera);
    camera.add(this.plane);
    this.renderer = this.viewer.renderer;
    this.originalRender = this.renderer.render;
    const backdrop = this;
    this.renderer.render = function (scene, renderCamera, ...rest) {
      backdrop.beforeRender(renderCamera);
      return backdrop.originalRender.call(this, scene, renderCamera, ...rest);
    };
  }

  // Only the mannequin: the skydome sphere, grid and capture frame would cover the layers below.
  hideEnvironment() {
    const viewer = this.viewer;
    if (viewer.directionalSkydome) viewer.directionalSkydome.visible = false;
    if (viewer.gridHelper) viewer.gridHelper.visible = false;
    if (viewer.captureFrame) viewer.captureFrame.visible = false;
    if (viewer.refPlane) viewer.refPlane.visible = false;
    if (viewer.scene.background) viewer.scene.background = null;
  }

  characterMeshes() {
    const meshes = [];
    if (this.viewer.skinnedMesh) meshes.push({ mesh: this.viewer.skinnedMesh, active: true });
    for (const [id, entry] of this.viewer.passiveCharacters?.entries?.() || []) {
      if (entry?.mesh?.visible !== false && entry?.mesh) meshes.push({ mesh: entry.mesh, id });
    }
    return meshes;
  }

  // Bounding sphere of the active rig, stored unscaled and relative to the mesh origin so a
  // per-frame plane update needs no vertex walk.
  measure() {
    const THREE = this.THREE;
    const mesh = this.viewer.skinnedMesh;
    if (!mesh) return null;
    mesh.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(mesh);
    if (box.isEmpty()) return null;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const scale = Math.max(1e-3, mesh.scale.x || 1);
    const origin = mesh.getWorldPosition(new THREE.Vector3());
    return {
      radius: Math.max(1e-3, sphere.radius / scale),
      offset: sphere.center.clone().sub(origin).divideScalar(scale),
    };
  }

  beforeRender(renderCamera) {
    this.hideEnvironment();
    const viewer = this.viewer;
    const camera = viewer.camera;
    // Captures of the layer pixels must hold only the mannequin; the plane writes no color anyway,
    // but keeping it out of foreign cameras avoids stray depth.
    this.plane.visible = renderCamera === camera;
    if (renderCamera !== camera || !viewer.orbit) return;
    this.updatePlane();
  }

  // Places the plane for the current camera: just behind the deepest character, so a character
  // can move closer to the camera (a stronger perspective effect) or deeper into the scene,
  // and the plane follows instead of ever cropping it. Never moves a character.
  updatePlane() {
    const viewer = this.viewer;
    const camera = viewer.camera;
    if (!this.bounds && viewer.skinnedMesh) this.bounds = this.measure();
    // Scaling the character (Pose Studio Zoom) moves the backdrop with it.
    const scale = Math.max(1e-3, viewer.skinnedMesh?.scale?.x || 1);
    const radius = (this.bounds?.radius || FALLBACK_RADIUS) * scale;
    const base = poseBackdropDistance(camera.position.distanceTo(viewer.orbit.target), radius);
    camera.updateMatrixWorld(true);
    const deepest = Math.max(-Infinity, ...this.measureCharacters().map((item) => item.farEdge));
    const distance = base + (Number.isFinite(deepest) ? Math.max(0, deepest - base) : 0);
    const size = poseBackdropSize(distance, camera.fov, camera.aspect, camera.zoom);
    this.plane.position.set(0, 0, -distance);
    this.plane.scale.set(size.width, size.height, 1);
    this.plane.updateMatrixWorld(true);
    this.distance = distance;
    return distance;
  }

  // Camera-space depth of each character's bounding-sphere center and far edge.
  measureCharacters() {
    const THREE = this.THREE;
    const camera = this.viewer.camera;
    const forward = camera.getWorldDirection(new THREE.Vector3());
    return this.characterMeshes().map((entry) => {
      const scale = Math.max(1e-3, entry.mesh.scale.x || 1);
      const radius = (this.bounds?.radius || FALLBACK_RADIUS) * scale;
      const center = entry.mesh.getWorldPosition(new THREE.Vector3());
      if (this.bounds) center.addScaledVector(this.bounds.offset, scale);
      const depth = center.sub(camera.position).dot(forward);
      return { ...entry, depth, radius, farEdge: depth + radius, forward };
    });
  }

  // Read-only snapshot for tests: backdrop distance and each character's far-edge depth.
  describe() {
    const characters = this.measureCharacters().map(({ active, depth, radius, farEdge }) => ({
      active: Boolean(active), depth, radius, farEdge,
    }));
    // The plane for the current camera, not the last rendered frame.
    const distance = this.viewer.orbit ? this.updatePlane() : null;
    return { distance, characters };
  }

  // A new mesh (character or morph change) needs fresh bounds.
  invalidate() {
    this.bounds = null;
  }

  dispose() {
    if (this.renderer && this.originalRender) this.renderer.render = this.originalRender;
    this.plane.parent?.remove(this.plane);
    this.plane.geometry.dispose();
    this.plane.material.dispose();
    this.renderer = null;
    this.originalRender = null;
  }
}
