# Feature Request: Object Bounding Boxes

Help me add a new feature to this repo.

## High-level

For each photo object, we should define a bounding box which has the following effects:

- if object is an organism, only within the bounding box is sent to iNaturalist as the observation photo
- only within the (first) bounding box is used to create the Compendium thumbnail
- for the individual observation pages:
  - photo viewer is initially zoomed to the (first) bounding box, or as zoomed in as possible while keeping the entire bounding box in view (i.e. the aspect ratio of the photo viewer need not change)
  - there are controls for zooming to entire picture (which kind of exists today), zooming to each bounding box, and toggling visibility of each bounding box

## Supporting Tooling

To easily support bounding box association, the publish-photo and publish-photo-csv scripts should raise dialogs to allow users (me) to draw bounding boxes when not provided, but bounding box(es) need not be defined for every photo (i.e. current content photos are acceptable as-is, but a new field which defaults to null may be added to the YAMLs if needed).

The existing interactive prompts should be consolidated into this new dialog.

The dialog should allow specification of multiple objects/bounding boxes with clear association feedback to the user for what bounding box corresponds to which object.

## Notes and Open Questions

### EXIF Metadata for Cropped Photo

Is there a standard for updating EXIF metadata for a cropped photo? It seems like cropping might invalidate some fields including, but maybe not limited to:

- ExifImageHeight
- ExifImageWidth
- FocalPlaneXResolution
- FocalPlaneYResolution
- XResolution
- YResolution

This should only affect the POST to iNaturalist. If no standard exists, let's discuss.

### Multiple Objects per Photo

Review existing tooling for appropriate support of multiple objects for the same photo. If the publish photo script is called multiple times for the same photo, then the action should be to append the object details to the existing YAML instead of creating another. If it seems like the object definition may be a duplicate (e.g. matching object details or almost identical bounding box), then warn the user with information and ask if they still wish to continue.

### Bounding Box Units

Use whatever bounding box definition makes sense. Follow existing standards if possible, like using top-left as origin (0, 0). Possible options:

1. origin + height + width in pixels
2. left + top + right + bottom (i.e. minx, miny, maxx, maxy in image space) in pixels

I lean toward #2 if there's no standard to follow, since each field is the same type (positive integer).
