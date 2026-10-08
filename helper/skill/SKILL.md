---
name: studio-media
description: Use whenever the task is to edit, build, render, or verify media in the Studio workspace: video (trim, captions, silence cuts, reframing), images (background removal, upscaling, batch resize, grading, thumbnails), audio (denoise, podcast cleanup, loudness, ducking, transcription), motion graphics (motion templates). Also use when changing the Studio UI or its design tokens.
---

# Studio media skill

Studio is a Claude Code-operated editing workspace. You edit through the `studio` CLI and the project file. You do not hand-edit renders, and you do not trust an output you have not inspected.

Read in this order the first time in a session:

1. `Context.md`: what Studio is, the project format, the CLI contract, engines and licenses.
2. `guidelines.md`: how to work, how to decide, how to report.
3. The rule files that match the task:

| Task | Read |
|---|---|
| Any task | `rules/00-core-rules.md`, `rules/01-project-and-ops.md` |
| Video | `rules/02-video.md`, `rules/08-render-and-export.md` |
| Audio | `rules/03-audio.md` |
| Images | `rules/04-image.md` |
| Motion graphics | `rules/05-motion-graphics.md` |
| Captions or subtitles | `rules/06-captions.md` |
| Verifying any output | `rules/09-verification.md` |
| Plugins, expressions, scripts, new effects or templates | `rules/12-plugins-and-scripts.md` |
| Speed, memory, bundle size | `rules/10-performance.md` |
| UI work or tokens | `rules/11-ui-design-system.md` |

If a rule file and a user instruction conflict, follow the user and say which rule you are overriding.
