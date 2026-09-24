# Remove background with keep-marking (design note)

Status: design only (user request 2026-09-23: think this through and save the
information). Not implemented yet.

## Problem

Automatic subject extraction (Remove bg - QI2.1 / Remove bg - BiRefNet)
sometimes removes elements the user wants to keep (held objects, props, hair
accessories, intentionally kept background elements). The user wants to CLICK
the elements they care about so extraction never removes them.

## Proposed UX: click-to-keep

1. Before running Remove bg, the user marks elements to keep either by:
   - clicking objects with the existing SAM-powered object-selection tool
     (each clicked segment is added to the keep set), and/or
   - painting keep areas with the existing mask brush.
2. Remove bg runs with the accumulated keep mask and never removes marked
   pixels.

## Chosen mechanism (v1): the Inpaint Mask layer is the keep mask

Zero new layer types: when Remove bg is invoked while the active mask layer
has painted pixels, those pixels are sent as the keep mask. The popover gains
a 'Keep areas: Inpaint Mask layer (N px painted) / none' line so the state is
visible.

## Backend contract

POST /vnccs/unicanvas/remove_bg gains an optional keep field (PNG data URL
of the mask; white = keep).

- BiRefNet path: final alpha = max(birefnet_alpha, keep_mask) - marked areas
  are forced opaque.
- QI2.1 path:
  1. hard constraint: alpha = max(extracted_alpha, keep_mask);
  2. soft conditioning: append to the subject-extraction instruction
     'Keep the marked regions fully visible in the output.'
- Undo semantics unchanged: one layerPixels history entry.

## SAM click-to-keep (v2)

A protect toggle on the SAM tool: every clicked object segment is unioned
into the keep mask (with an on-canvas green overlay preview and an undo entry
per click). This realizes the click-which-elements-interest-me flow directly.
