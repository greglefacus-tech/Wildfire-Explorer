---
name: WebGL preview limitation
description: In-tool screenshot validation may fail before the Three.js scene renders.
---

The screenshot browser has repeatedly failed to create a WebGL context for this game, so it cannot currently validate the 3D scene visually.

**Why:** the preview reports that its browser environment cannot create a GPU context; this is separate from the app's TypeScript and Vite build checks.

**How to apply:** When a screenshot shows the scene-loading error, do not treat that capture alone as evidence of a source regression. Verify compilation and test the game in a browser with WebGL support.
