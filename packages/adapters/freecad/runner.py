"""
NAQSH FreeCAD runner (Phase 12).

This is the ENTIRE FreeCAD-side surface NAQSH ever talks to. It is invoked
as a one-shot subprocess per operation by packages/adapters/src/
freecad-runtime.ts -- there is no persistent server, no long-lived FreeCAD
process, and no channel back into this script other than a single
base64-encoded JSON request passed as argv[1].

Security boundary (Phase 12 Step 14): this script dispatches to a FIXED,
explicit table of named operations (OPERATIONS below). It never calls
"eval" or "exec" on request data, never imports or runs caller-supplied code,
and never accepts a "run this Python" style operation. Adding a new
capability means adding a new named function here and wiring it into
OPERATIONS -- there is no generic "execute" primitive for an agent (or a
model) to reach through.

Output contract: exactly one line is printed to stdout, of the form
    @@NAQSH_RESULT@@<json>
This is a single line (json.dumps with no indentation) so it can be found
by scanning stdout line-by-line even though FreeCAD itself prints its own
startup banner and Recompute/Importing/Postprocessing progress noise
around it (observed to be interleaved / trailing, not necessarily
sequential -- the sentinel is what makes this reliable, not output
ordering). Anything unexpected (an exception this script's own try/except
didn't anticipate) still produces a well-formed @@NAQSH_RESULT@@ line with
status "error" -- the one thing this script must never do is let a raw
Python traceback become the primary result channel. Tracebacks are still
written to stderr for debugging, never swallowed.
"""

import sys
import json
import base64
import math
import os
import shutil
import traceback
import uuid

RESULT_PREFIX = "@@NAQSH_RESULT@@"

# Property editor modes that mean "NAQSH should treat this as read-only" --
# both an explicit ReadOnly flag and Hidden (properties FreeCAD's own UI
# does not surface for editing either) are treated conservatively as
# non-writable. This is a deliberate, documented safety default, not an
# attempt to perfectly mirror FreeCAD's own semantics.
NON_WRITABLE_EDITOR_MODES = {"ReadOnly", "Hidden"}

MAX_LIST_LENGTH = 50
MAX_NORMALIZE_DEPTH = 6


def normalize_value(value, depth=0):
    """Convert one FreeCAD property value into a JSON-safe NAQSH value.

    Never raises -- an unrecognized/unconvertible FreeCAD type becomes an
    explicit {"unsupported": true, "pythonType": ...} marker rather than a
    crash or a silently-dropped field (Phase 12 Step 8: distinguish
    readable / unsupported / read-failure, never let one bad property
    abort the whole observation).
    """
    if depth > MAX_NORMALIZE_DEPTH:
        return {"unsupported": True, "reason": "max_depth_exceeded"}
    if value is None or isinstance(value, bool) or isinstance(value, (int, float, str)):
        return value

    type_name = type(value).__name__

    if type_name == "Vector":
        try:
            return {"x": value.x, "y": value.y, "z": value.z}
        except Exception:
            pass

    if type_name == "Quantity":
        try:
            return {"value": value.Value, "unit": str(value.Unit)}
        except Exception:
            pass

    if type_name == "Placement":
        try:
            base = value.Base
            return {
                "position": {"x": base.x, "y": base.y, "z": base.z},
                "angle": value.Rotation.Angle,
            }
        except Exception:
            pass

    if isinstance(value, (list, tuple)):
        if len(value) > MAX_LIST_LENGTH:
            return {"unsupported": True, "reason": "array_too_large", "length": len(value)}
        return [normalize_value(item, depth + 1) for item in value]

    # Anything else (TopoShape/Solid, Material, App::Link targets, ...) is
    # intentionally NOT dumped -- these are exactly the "enormous or
    # unstable payload" risks Phase 12 Step 7 warns against.
    return {"unsupported": True, "pythonType": type_name}


def get_properties(obj):
    """`readOnly` (Phase 14 audit finding) reflects whether NAQSH itself
    will let this property be written through `modify_object`, NOT merely
    whether FreeCAD's own UI hides the edit box for it. A real Part::Box
    reports ~15 properties FreeCAD itself considers editable (AttacherEngine,
    AttachmentSupport, Placement, ...), but Phase 14's SUPPORTED_MUTATIONS
    allowlist (Step 8) exposes exactly THREE of them -- reporting the other
    twelve as `readOnly: false` would be actively misleading (a caller
    inspecting this object would have no way to know `modify_object` will
    reject them) and would silently violate the "no arbitrary property
    writes" security requirement's spirit even though the allowlist itself
    still enforces it correctly. `SUPPORTED_MUTATIONS` is referenced here
    even though it's defined later in this module -- safe in Python, since
    a function body resolves a global name at CALL time, and by the time
    any operation actually runs, the whole module has already finished
    loading."""
    type_id = getattr(obj, "TypeId", None)
    allowed_mutations = SUPPORTED_MUTATIONS.get(type_id, {})

    properties = []
    try:
        names = list(obj.PropertiesList)
    except Exception:
        names = []
    for name in names:
        if name in allowed_mutations:
            read_only = False
        else:
            read_only = True
        try:
            raw_value = getattr(obj, name)
            value = normalize_value(raw_value)
        except Exception as error:
            value = {"unsupported": True, "reason": "read_failed", "message": str(error)}
        properties.append({"key": name, "value": value, "readOnly": read_only})
    return properties


def get_relationships(obj, errors):
    """Only FreeCAD-reported dependency links are exposed, differentiated by
    the MECHANISM that reported them (Phase 13 Step 9/11) -- never inferred
    from naming/position/likelihood:

    - "contains": from a container's own `.Group` list (App::Part,
      App::DocumentObjectGroup). Reported once per child, on the container.
    - "links_to": from `App::Link`'s own `.LinkedObject` property.
    - "references": the residual generic dependency, from `obj.OutList`,
      for every target not already classified above (unchanged from Phase
      12 -- e.g. Part::Cut's Base/Tool). A target already reported as
      "contains"/"links_to" is not ALSO reported as "references" here.

    Sorted by (type, targetId) for deterministic output (Phase 13 Step 14):
    FreeCAD's own `.Group`/`.OutList` ordering is not a documented
    contract, so this script imposes one rather than depending on it.

    `errors` (a mutable list this function appends to) records any
    candidate relationship this function could not safely describe --
    audit finding: an earlier version silently `continue`d past these with
    no trace at all (no warning, no error), which is exactly the "swallowed
    exception" this repository's error-handling discipline forbids
    elsewhere (see normalize_value's own `{unsupported: true, ...}` marker
    for the equivalent property-level case). A candidate relationship
    failing to resolve is unlikely in practice (it would require an object
    reference obtained directly from `.Group`/`.OutList`/`.LinkedObject` to
    not have a working `.Name`), but "unlikely" is not "impossible" for a
    real, imperfect engineering file, so it is still reported rather than
    silently dropped.
    """
    relationships = []
    seen_targets = set()

    try:
        group = getattr(obj, "Group", None)
    except Exception:
        group = None
    if isinstance(group, (list, tuple)):
        for child in group:
            try:
                relationships.append({"type": "contains", "targetId": child.Name, "metadata": {}})
                seen_targets.add(child.Name)
            except Exception as error:
                errors.append(
                    {
                        "kind": "relationship_inspection_failed",
                        "objectId": obj.Name,
                        "message": "contains: %s: %s" % (type(error).__name__, str(error)),
                    }
                )

    try:
        linked = getattr(obj, "LinkedObject", None)
    except Exception:
        linked = None
    if linked is not None:
        try:
            relationships.append({"type": "links_to", "targetId": linked.Name, "metadata": {}})
            seen_targets.add(linked.Name)
        except Exception as error:
            errors.append(
                {
                    "kind": "relationship_inspection_failed",
                    "objectId": obj.Name,
                    "message": "links_to: %s: %s" % (type(error).__name__, str(error)),
                }
            )

    try:
        out_list = obj.OutList
    except Exception:
        out_list = []
    for other in out_list:
        try:
            if other.Name in seen_targets:
                continue
            relationships.append({"type": "references", "targetId": other.Name, "metadata": {}})
        except Exception as error:
            errors.append(
                {
                    "kind": "relationship_inspection_failed",
                    "objectId": obj.Name,
                    "message": "references: %s: %s" % (type(error).__name__, str(error)),
                }
            )

    relationships.sort(key=lambda relationship: (relationship["type"], relationship["targetId"]))
    return relationships


# Reliable, mechanism-based classification rules for
# EnvironmentObjectGenericType (Phase 13 Step 6) -- checked in order, first
# match wins. Sketch is checked BEFORE Part::Feature because
# Sketcher::SketchObject is ALSO derived from Part::Feature (confirmed
# empirically against a real FreeCAD 1.1.3 install) -- without this
# ordering every sketch would be misclassified as "solid". Deliberately
# small: only categories this script can classify via a genuine FreeCAD API
# check are included, matching the "unknown is better than a false
# classification" rule -- no speculative "feature"/"assembly" buckets that
# nothing here actually produces.
_GENERIC_TYPE_RULES = (
    (("App::Part", "App::DocumentObjectGroup"), "container"),
    (("App::Link",), "link"),
    (("Sketcher::SketchObject",), "sketch"),
    (("Part::Datum", "App::OriginFeature", "App::Origin"), "datum"),
    (("Part::Feature",), "solid"),
)


def get_generic_type(obj):
    for base_types, generic_type in _GENERIC_TYPE_RULES:
        for base_type in base_types:
            try:
                if obj.isDerivedFrom(base_type):
                    return generic_type
            except Exception:
                continue
    return "unknown"


def find_parent_id(obj):
    """The container (if any) whose `.Group` lists `obj` as a child --
    Phase 13 Step 5/10: only a RELIABLE, FreeCAD-reported containment
    mechanism, never inferred. Searches `obj.InList` (objects that
    reference `obj` in some way, typically small) rather than scanning the
    whole document, and sorts candidates by name first so the result is
    deterministic even in the unusual case of more than one candidate
    genuinely containing the same object."""
    try:
        candidates = sorted(obj.InList, key=lambda candidate: candidate.Name)
    except Exception:
        return None
    for candidate in candidates:
        try:
            group = getattr(candidate, "Group", None)
            if isinstance(group, (list, tuple)) and obj in group:
                return candidate.Name
        except Exception:
            continue
    return None


def get_visibility(obj):
    try:
        value = getattr(obj, "Visibility", None)
        if isinstance(value, bool):
            return value
    except Exception:
        pass
    return None


EMPTY_GEOMETRY = {
    "available": False,
    "reason": "no_shape",
    "valid": None,
    "boundingBox": None,
    "volume": None,
    "surfaceArea": None,
    "centerOfMass": None,
    "solidCount": None,
    "faceCount": None,
    "edgeCount": None,
    "vertexCount": None,
    "shapeType": None,
}

# Distinct reason from "no_shape"/"invalid_shape" (both genuine facts about
# the object itself) -- this one means geometry was never ATTEMPTED for
# this call, a caller-visible, honest signal rather than looking identical
# to "this object truly has no geometry" (Phase 13 Step 22 audit finding:
# see get_geometry()'s own comment for why list_objects passes
# include_geometry=False).
GEOMETRY_NOT_REQUESTED_REASON = "not_requested_in_listing"


def get_geometry(obj):
    """BOUNDED, best-effort geometry metadata (Phase 13 Step 12) -- never a
    geometry kernel abstraction, never a BREP dump. Every metric is
    computed independently (`_safe`) so one unreadable metric (observed
    empirically: a Sketch's `.Shape` exists but raises on `.Volume`/etc
    with "shape is invalid") never blanks out the others or aborts object
    inspection -- it just becomes `null` for that one field."""
    try:
        shape = getattr(obj, "Shape", None)
    except Exception:
        shape = None
    if shape is None:
        return dict(EMPTY_GEOMETRY)

    def _safe(fn):
        try:
            return fn()
        except Exception:
            return None

    valid = _safe(lambda: bool(shape.isValid()))
    if not valid:
        geometry = dict(EMPTY_GEOMETRY)
        geometry["reason"] = "invalid_shape"
        geometry["valid"] = valid
        return geometry

    bbox = _safe(lambda: shape.BoundBox)
    bounding_box = None
    if bbox is not None:
        bounding_box = _safe(
            lambda: {
                "min": {"x": bbox.XMin, "y": bbox.YMin, "z": bbox.ZMin},
                "max": {"x": bbox.XMax, "y": bbox.YMax, "z": bbox.ZMax},
            }
        )

    center = _safe(lambda: shape.CenterOfMass)
    center_of_mass = None
    if center is not None:
        center_of_mass = _safe(lambda: {"x": center.x, "y": center.y, "z": center.z})

    return {
        "available": True,
        "reason": None,
        "valid": valid,
        "boundingBox": bounding_box,
        "volume": _safe(lambda: shape.Volume),
        "surfaceArea": _safe(lambda: shape.Area),
        "centerOfMass": center_of_mass,
        "solidCount": _safe(lambda: len(shape.Solids)),
        "faceCount": _safe(lambda: len(shape.Faces)),
        "edgeCount": _safe(lambda: len(shape.Edges)),
        "vertexCount": _safe(lambda: len(shape.Vertexes)),
        "shapeType": _safe(lambda: shape.ShapeType),
    }


def object_to_dict(obj, include_geometry=True, errors=None):
    """`include_geometry=False` (used by `op_list_objects`, Phase 13 Step
    22 audit finding) skips `get_geometry()` entirely -- computing bounding
    box/volume/area/center-of-mass/topology counts for EVERY object on
    EVERY `list_objects()` call is real, repeated, UNCACHED cost (each
    call reopens the document fresh; there is no cross-call FreeCAD state
    to memoize against). A real engineering assembly can have hundreds of
    complex solids -- forcing full geometry for the whole inventory every
    time it's listed does not "degrade predictably". `inspect_object`
    (exactly one object) always computes it: that cost is bounded by
    definition and is exactly what a caller asking for ONE object's full
    detail is asking for.

    `errors` is an optional mutable list `get_relationships()` appends to
    -- passed through from the caller (`op_list_objects`/`op_inspect_object`)
    so a relationship-inspection failure for THIS object is reported
    alongside the document/object's other diagnostics rather than only
    ever being visible to a caller that happens to pass one in."""
    if errors is None:
        errors = []
    label = getattr(obj, "Label", None) or obj.Name
    if include_geometry:
        geometry = get_geometry(obj)
    else:
        geometry = dict(EMPTY_GEOMETRY)
        geometry["reason"] = GEOMETRY_NOT_REQUESTED_REASON
    return {
        "id": obj.Name,
        "type": getattr(obj, "TypeId", "Unknown"),
        "name": label,
        "genericType": get_generic_type(obj),
        "parentId": find_parent_id(obj),
        "visible": get_visibility(obj),
        "geometry": geometry,
        "properties": get_properties(obj),
        "relationships": get_relationships(obj, errors),
        "metadata": {},
    }


def _open(file_path):
    import FreeCAD

    return FreeCAD.openDocument(file_path)


def _close(doc):
    import FreeCAD

    try:
        FreeCAD.closeDocument(doc.Name)
    except Exception:
        pass


def op_health(params):
    import FreeCAD

    version = FreeCAD.Version()
    return {"status": "healthy", "version": ".".join(str(part) for part in version[0:3]), "raw": list(version)}


def op_connect(params):
    file_path = params["filePath"]
    doc = _open(file_path)
    try:
        return {
            "documentName": getattr(doc, "Label", None) or doc.Name,
            "internalName": doc.Name,
            "objectCount": len(doc.Objects),
        }
    finally:
        _close(doc)


def op_list_objects(params):
    """Sorted by `.Name` for deterministic output (Phase 13 Step 14) --
    FreeCAD's own `doc.Objects` iteration order is not a documented
    contract. Per-object failures are collected into `inspectionErrors`
    rather than aborting the whole call (Phase 13 Step 16): one object this
    script cannot safely describe must not make an entire real, otherwise-
    healthy document un-inspectable."""
    file_path = params["filePath"]
    doc = _open(file_path)
    try:
        objects = []
        errors = []
        for obj in sorted(doc.Objects, key=lambda candidate: candidate.Name):
            try:
                objects.append(object_to_dict(obj, include_geometry=False, errors=errors))
            except Exception as error:
                errors.append(
                    {
                        "kind": "object_unavailable",
                        "objectId": getattr(obj, "Name", None),
                        "message": "%s: %s" % (type(error).__name__, str(error)),
                    }
                )
        return {"objects": objects, "inspectionErrors": errors}
    finally:
        _close(doc)


def op_inspect_document(params):
    """The cheapest inspection tier (Phase 13 Step 3/4/13): document
    identity, object count/ids, and hierarchy roots only -- no per-object
    properties/relationships/geometry, so an agent can get a document
    overview without paying for a full `list_objects` call."""
    import FreeCAD

    file_path = params["filePath"]
    doc = _open(file_path)
    try:
        object_ids = sorted(obj.Name for obj in doc.Objects)
        root_ids = sorted(obj.Name for obj in doc.RootObjects)
        version = FreeCAD.Version()
        return {
            "documentId": doc.Name,
            "documentName": getattr(doc, "Label", None) or doc.Name,
            "filePath": getattr(doc, "FileName", None) or file_path,
            "objectCount": len(object_ids),
            "objectIds": object_ids,
            "rootObjectIds": root_ids,
            "environmentVersion": ".".join(str(part) for part in version[0:3]),
        }
    finally:
        _close(doc)


def op_inspect_object(params):
    file_path = params["filePath"]
    object_id = params["objectId"]
    doc = _open(file_path)
    try:
        obj = doc.getObject(object_id)
        if obj is None:
            return {"found": False}
        errors = []
        return {"found": True, "object": object_to_dict(obj, errors=errors), "inspectionErrors": errors}
    finally:
        _close(doc)


def op_save(params):
    file_path = params["filePath"]
    doc = _open(file_path)
    try:
        doc.save()
        return {"saved": True}
    finally:
        _close(doc)


_HEX_DIGITS = set("0123456789abcdef")


def _is_valid_checkpoint_id(checkpoint_id):
    """`checkpoint_id` is only ever legitimately a `uuid.uuid4().hex`
    string this script itself generated (op_checkpoint below) -- exactly
    32 lowercase hex characters, never a path separator or `..` segment.
    Validated HERE, at the point a caller-supplied string is about to be
    joined into a filesystem path, rather than trusting the TypeScript
    layer above to have already done so (Phase 15 audit finding: without
    this check, a `checkpointId` containing `../` would let `op_restore`
    copy an ARBITRARY file on disk over the live document -- a path
    traversal vulnerability, even though today's only real caller
    (`restore_checkpoint`) always supplies a server-generated id)."""
    return isinstance(checkpoint_id, str) and len(checkpoint_id) == 32 and set(checkpoint_id) <= _HEX_DIGITS


def _checkpoint_dir(file_path):
    """A hidden sibling directory next to the document itself -- not a
    separate configured location, so a checkpointed document stays
    self-contained with the file it belongs to (copy the whole project
    folder, get the checkpoints too)."""
    directory = os.path.join(os.path.dirname(os.path.abspath(file_path)), ".naqsh_checkpoints")
    os.makedirs(directory, exist_ok=True)
    return directory


def op_checkpoint(params):
    """Phase 15: a REAL, recoverable snapshot of the current FreeCAD
    document -- a plain file copy, never a fabricated/fake pointer.
    FreeCAD documents ARE files on disk; the file itself already is the
    environment's own recoverable representation, so copying it IS a
    genuine snapshot ("if the current FreeCAD architecture uses document
    files ... use that mechanism. Do NOT invent a fake snapshot.").

    Opens and immediately closes the document once first -- never copies
    raw, unverified bytes -- so a genuinely corrupt/unopenable file is
    rejected here (as a normal exception, surfaced as `environment_
    failure` by `main()`) rather than silently "checkpointed" and only
    discovered broken much later at restore time.
    """
    file_path = params["filePath"]
    doc = _open(file_path)
    _close(doc)

    checkpoint_id = uuid.uuid4().hex
    snapshot_path = os.path.join(_checkpoint_dir(file_path), checkpoint_id + ".FCStd")
    shutil.copy2(file_path, snapshot_path)
    return {"checkpointId": checkpoint_id}


def op_restore(params):
    """Phase 15: restores the live document to a previously checkpointed
    state by copying the snapshot file back over it. `shutil.copy2` either
    completes wholesale or raises -- there is no code path that leaves
    `file_path` partially overwritten. A missing/unknown `checkpointId`
    is reported as `{"found": False}`, the same "no such record" shape
    `op_modify_object`/`op_inspect_object` already use, rather than a
    generic exception.
    """
    file_path = params["filePath"]
    checkpoint_id = params["checkpointId"]
    if not _is_valid_checkpoint_id(checkpoint_id):
        # Malformed input is reported identically to "not found" -- never
        # a different error that would let a caller distinguish "wrong
        # shape" from "genuinely unknown id" (no oracle for probing valid
        # id formats), and never a path join with untrusted characters.
        return {"found": False}
    snapshot_path = os.path.join(_checkpoint_dir(file_path), checkpoint_id + ".FCStd")
    if not os.path.isfile(snapshot_path):
        return {"found": False}
    shutil.copy2(snapshot_path, file_path)
    return {"found": True, "restored": True}


# Phase 14 Step 8: the FIRST real mutation capability against a real
# FreeCAD document -- deliberately an explicit ALLOWLIST, not a generic
# "write any property" path. Adding a new writable mutation means adding an
# entry here; there is no other way to reach setattr() on a FreeCAD object
# from this script. FreeCAD reports ~15-20 properties even on a bare
# Part::Box (see get_properties()'s own PropertiesList enumeration); this
# table intentionally exposes exactly THREE of them, the ones that are
# genuinely simple, dimensional, and safe to validate exhaustively.
# `min`/`max` are deliberately conservative sanity bounds (not real
# engineering constraints) -- see op_modify_object's own docstring for why
# they exist at all (FreeCAD does not reject an out-of-range value itself).
SUPPORTED_MUTATIONS = {
    "Part::Box": {
        "Length": {"min": 0.001, "max": 100000.0},
        "Width": {"min": 0.001, "max": 100000.0},
        "Height": {"min": 0.001, "max": 100000.0},
    },
    # A solid of revolution -- wheels, hubs, shafts, bosses, pins.
    "Part::Cylinder": {
        "Radius": {"min": 0.001, "max": 100000.0},
        "Height": {"min": 0.001, "max": 100000.0},
    },
    # The ring/donut primitive. This is what an actual tyre is: Radius1 is
    # the distance from the axis out to the centre of the tube (so it sets
    # the wheel size), and Radius2 is the tube's own cross-section radius
    # (so it sets how fat the tyre is). Both are bounded exactly like every
    # other allowlisted dimension -- no new class of write is introduced
    # here, only two more named numeric properties on one more named type.
    "Part::Torus": {
        "Radius1": {"min": 0.001, "max": 100000.0},
        "Radius2": {"min": 0.001, "max": 100000.0},
    },
}


# Ordinary engineering vocabulary for the SAME physical dimension, scoped
# per type. Lives here, immediately beside SUPPORTED_MUTATIONS, because
# this is the only place that reliably knows an object's real TypeId --
# on modify the caller supplies only an objectId, so the TypeScript layer
# genuinely cannot resolve "Thickness" without another round trip.
#
# This translates names; it can never widen what may be written. Every
# resolved name is still checked against SUPPORTED_MUTATIONS below, and a
# word with no entry here is passed through untouched so it is rejected
# honestly rather than guessed at.
#
# "Diameter" is deliberately absent: silently treating a diameter as a
# radius would build the part at half the requested size and report
# success, which is worse than an honest rejection.
PROPERTY_SYNONYMS = {
    "Part::Box": {
        "length": "Length", "long": "Length",
        "width": "Width", "wide": "Width", "depth": "Width",
        "height": "Height", "tall": "Height", "thickness": "Height", "thick": "Height",
    },
    "Part::Cylinder": {
        "radius": "Radius",
        "height": "Height", "tall": "Height", "length": "Height",
        "thickness": "Height", "thick": "Height", "depth": "Height",
    },
    "Part::Torus": {
        # Radius1 = ring radius (wheel size); Radius2 = tube radius (tyre fatness).
        "radius": "Radius1", "radius1": "Radius1", "ringradius": "Radius1",
        "radius2": "Radius2", "tuberadius": "Radius2",
        "thickness": "Radius2", "thick": "Radius2", "width": "Radius2",
    },
}


# Where a part sits, and how it is turned. EVERY FreeCAD object has a
# Placement, so these apply to every supported type rather than living in
# any one type's entry.
#
# They are exposed as plain bounded numbers -- PositionX/Y/Z in mm, a
# rotation angle in degrees about a named axis -- rather than as FreeCAD's
# own compound Placement object, so that the exact same "named property,
# validated against explicit min/max, nothing else may be written"
# discipline covers them. No caller can reach FreeCAD's Placement API
# itself; they can only set these seven numbers.
#
# Without this, every object a caller creates lands at the origin stacked
# on top of every other one, which makes any assembly of more than one
# part impossible to express.
PLACEMENT_PROPERTIES = {
    "PositionX": {"min": -1000000.0, "max": 1000000.0},
    "PositionY": {"min": -1000000.0, "max": 1000000.0},
    "PositionZ": {"min": -1000000.0, "max": 1000000.0},
    "RotationAngle": {"min": -360.0, "max": 360.0},
    "RotationAxisX": {"min": -1.0, "max": 1.0},
    "RotationAxisY": {"min": -1.0, "max": 1.0},
    "RotationAxisZ": {"min": -1.0, "max": 1.0},
}

PLACEMENT_SYNONYMS = {
    "x": "PositionX", "positionx": "PositionX", "px": "PositionX",
    "y": "PositionY", "positiony": "PositionY", "py": "PositionY",
    "z": "PositionZ", "positionz": "PositionZ", "pz": "PositionZ",
    "angle": "RotationAngle", "rotation": "RotationAngle", "rotationangle": "RotationAngle",
    "axisx": "RotationAxisX", "rotationaxisx": "RotationAxisX",
    "axisy": "RotationAxisY", "rotationaxisy": "RotationAxisY",
    "axisz": "RotationAxisZ", "rotationaxisz": "RotationAxisZ",
}


def _split_placement(properties):
    """Separates placement numbers from shape dimensions. Returns
    (shape_properties, placement_properties)."""
    shape = {}
    placement = {}
    for key, value in properties.items():
        if key in PLACEMENT_PROPERTIES:
            placement[key] = value
        else:
            shape[key] = value
    return shape, placement


def _validate_placement(placement):
    """Same bounds discipline as every shape property. Returns a rejection
    dict, or None when every value is acceptable."""
    for key, value in placement.items():
        if not _is_finite_number(value):
            return _rejected("invalid_value", 'Value for "%s" must be a finite number (got %r)' % (key, value))
        constraints = PLACEMENT_PROPERTIES[key]
        if value < constraints["min"] or value > constraints["max"]:
            return _rejected(
                "value_out_of_range",
                '"%s" must be between %s and %s (got %s)' % (key, constraints["min"], constraints["max"], value),
            )
    return None


def _apply_placement(obj, placement):
    """Writes the validated numbers onto the object's real Placement.

    Reads the object's CURRENT placement first so that setting only X
    leaves Y, Z and the rotation exactly as they were -- a partial update
    must never silently reset the parts it wasn't asked about.
    """
    if not placement:
        return
    import FreeCAD

    current = obj.Placement
    position = FreeCAD.Vector(
        placement.get("PositionX", current.Base.x),
        placement.get("PositionY", current.Base.y),
        placement.get("PositionZ", current.Base.z),
    )

    has_rotation = any(key.startswith("Rotation") for key in placement)
    if has_rotation:
        axis = FreeCAD.Vector(
            placement.get("RotationAxisX", 0.0),
            placement.get("RotationAxisY", 0.0),
            placement.get("RotationAxisZ", 0.0),
        )
        # An all-zero axis is not a rotation FreeCAD can represent; fall
        # back to Z, the conventional default, rather than raising.
        if axis.Length == 0:
            axis = FreeCAD.Vector(0.0, 0.0, 1.0)
        rotation = FreeCAD.Rotation(axis, placement.get("RotationAngle", 0.0))
    else:
        rotation = current.Rotation

    obj.Placement = FreeCAD.Placement(position, rotation)


def _normalize_property_key(type_id, key):
    """Maps one caller-supplied property name onto the real FreeCAD
    property for `type_id`, or returns it unchanged when nothing matches."""
    allowed = SUPPORTED_MUTATIONS.get(type_id, {})
    if key in allowed or key in PLACEMENT_PROPERTIES:
        return key
    flattened = "".join(ch for ch in str(key).lower() if ch.isalnum())
    if flattened in PLACEMENT_SYNONYMS:
        return PLACEMENT_SYNONYMS[flattened]
    return PROPERTY_SYNONYMS.get(type_id, {}).get(flattened, key)


def _normalize_properties(type_id, properties):
    return {_normalize_property_key(type_id, key): value for key, value in properties.items()}


def _is_finite_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _numeric_property_value(value):
    """Extracts a plain, JSON-comparable number from a FreeCAD property
    value for before/after/expectedBefore comparison. Every property this
    script currently allows mutating is a Quantity (Length/Width/Height on
    Part::Box) -- `.Value` is its plain float in the document's current
    unit. Raises for anything else rather than silently guessing, since
    SUPPORTED_MUTATIONS should never name a non-numeric property in the
    first place (a mismatch here means this table and this function have
    drifted apart, which must fail loudly, not guess)."""
    type_name = type(value).__name__
    if type_name == "Quantity":
        return value.Value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return value
    raise TypeError("unsupported numeric property type: %s" % type_name)


def _rejected(reason, message):
    return {"found": True, "rejected": True, "reason": reason, "message": message}


def op_modify_object(params):
    """Phase 14: validate everything BEFORE mutating anything, mutate,
    recompute, verify the result is genuinely valid, and ONLY THEN persist
    -- see this module's Phase 14 audit comments below for exactly why each
    step exists. FreeCAD itself does NOT raise for an out-of-range or NaN
    value (confirmed empirically against a real FreeCAD 1.1.3 install): an
    out-of-range Part::Box.Length is silently CLAMPED (e.g. -5 becomes
    0.0), and a NaN Length is accepted outright, only surfacing as an
    invalid Shape after recompute. This function is the only thing
    standing between "the agent asked for something dangerous" and
    "FreeCAD quietly did something else instead" -- every validation below
    happens before any setattr(), and the document is never saved unless
    the resulting geometry actually recomputes into a valid state (Phase
    14 Step 10's "transaction-like safety": a crash or a rejected result
    leaves the on-disk file exactly as it was, because save() was never
    reached).
    """
    file_path = params["filePath"]
    object_id = params["objectId"]
    changes = params.get("changes") or {}
    expected_before = params.get("expectedBefore")

    doc = _open(file_path)
    try:
        obj = doc.getObject(object_id)
        if obj is None:
            return {"found": False}

        type_id = getattr(obj, "TypeId", None)
        allowed = SUPPORTED_MUTATIONS.get(type_id)
        if allowed is None:
            return _rejected("unsupported_target_type", 'Object type "%s" has no supported mutations in Phase 14' % (type_id,))

        # Resolved against the object's REAL TypeId, which only this side
        # of the boundary knows on a modify (the caller sends an objectId,
        # not a type).
        changes = _normalize_properties(type_id, changes)
        changes, placement = _split_placement(changes)
        placement_rejection = _validate_placement(placement)
        if placement_rejection is not None:
            return placement_rejection

        for key in changes:
            if key not in allowed:
                return _rejected("unsupported_property", 'Property "%s" is not a supported mutation for "%s"' % (key, type_id))
            try:
                editor_mode = set(obj.getEditorMode(key))
            except Exception:
                editor_mode = set()
            if editor_mode & NON_WRITABLE_EDITOR_MODES:
                return _rejected("read_only_property", 'Property "%s" is currently read-only on this object' % (key,))

        # Read CURRENT values before anything mutates -- needed for both
        # the expectedBefore stale-state check and the before/after record.
        # Deliberately BEFORE value-type/range validation below: staleness
        # is a precondition about the ENVIRONMENT's current state, entirely
        # independent of whether the NEWLY requested value would otherwise
        # be valid -- a stale/conflicting call should be reported as stale,
        # not as "invalid value", even if the requested value also happens
        # to be malformed.
        before_values = {}
        for key in changes:
            try:
                before_values[key] = _numeric_property_value(getattr(obj, key))
            except Exception as error:
                return _rejected("property_read_failed", 'Could not read current value of "%s": %s' % (key, str(error)))

        if expected_before:
            for key, expected in expected_before.items():
                if key in before_values and before_values[key] != expected:
                    return _rejected(
                        "stale_state",
                        'expectedBefore mismatch for "%s": current value is %r, expected %r' % (key, before_values[key], expected),
                    )

        # Phase 14 Step 16: idempotency -- every requested value already
        # matches the current one, so there is genuinely nothing to do.
        # Also checked before value-type/range validation: a request that
        # merely re-states the current (necessarily already-valid) value
        # should short-circuit as a no-op, not be re-validated. Deliberately
        # NOT guarded by `changes and ...`: `all()` of an empty generator is
        # `True`, so an EMPTY `changes` dict also takes this same safe,
        # no-op, no-save path (matching in-memory-environment.ts's identical
        # `[].every(...) === true` behavior for zero requested changes) --
        # audit fix: the earlier `changes and` guard let an empty request
        # fall through all the way to an unconditional `doc.save()` with
        # nothing actually changed, reporting a "successful" mutation that
        # mutated nothing.
        # `changes` alone is not the whole request: a placement-only
        # modify (move this part, leave its dimensions) arrives with an
        # EMPTY changes dict, and `all()` over an empty sequence is
        # vacuously true -- which would report "nothing to do" and skip
        # the move entirely. Caught by a real test that moved a box in x
        # and found it still sitting at its original position.
        if not placement and all(before_values[key] == changes[key] for key in changes):
            errors = []
            return {
                "found": True,
                "rejected": False,
                "alreadySatisfied": True,
                "propertyChanges": [
                    {"key": key, "before": before_values[key], "requested": changes[key], "after": before_values[key]} for key in changes
                ],
                "object": object_to_dict(obj, errors=errors),
                "inspectionErrors": errors,
            }

        for key, value in changes.items():
            if not _is_finite_number(value):
                return _rejected("invalid_value", 'Value for "%s" must be a finite number (got %r)' % (key, value))
            constraints = allowed[key]
            if value < constraints["min"] or value > constraints["max"]:
                return _rejected(
                    "value_out_of_range",
                    '"%s" must be between %s and %s (got %s)' % (key, constraints["min"], constraints["max"], value),
                )

        for key, value in changes.items():
            setattr(obj, key, value)
        _apply_placement(obj, placement)

        doc.recompute()

        # Do not assume a successful setter means the modification
        # succeeded (Phase 14 Step 4) -- verify the RESULTING geometry.
        shape = getattr(obj, "Shape", None)
        if shape is not None:
            try:
                shape_valid = bool(shape.isValid())
            except Exception:
                shape_valid = False
            if not shape_valid:
                # NEVER call doc.save() here -- the on-disk file stays
                # exactly as it was; closing this document without saving
                # discards the attempted mutation entirely.
                return _rejected("invalid_resulting_geometry", "The requested change produced an invalid shape and was not saved")

        doc.save()

        # From here on, the mutation has ALREADY happened and been
        # persisted -- Phase 14 Step 13/16 audit finding: a failure in the
        # POST-modification re-read (extremely unlikely for a simple
        # Quantity property, but not impossible) must never be reported as
        # "the modification failed". Doing so would silently discard proof
        # of a real, saved, successful change -- worse than the failure it
        # would be reporting. Every step below degrades to a warning, never
        # an exception that would make main() report status "error" for an
        # already-successful mutation.
        warnings = []

        after_values = {}
        for key in changes:
            try:
                after_values[key] = _numeric_property_value(getattr(obj, key))
            except Exception as error:
                after_values[key] = None
                warnings.append('Could not confirm the actual resulting value of "%s" after a successful, saved mutation: %s' % (key, str(error)))

        errors = []
        try:
            object_dict = object_to_dict(obj, errors=errors)
        except Exception as error:
            warnings.append("Could not fully re-inspect the object after a successful, saved mutation -- falling back to a lighter inspection: %s" % str(error))
            try:
                object_dict = object_to_dict(obj, include_geometry=False, errors=errors)
            except Exception as fallback_error:
                warnings.append("Falling back to a minimal object record: %s" % str(fallback_error))
                object_dict = {
                    "id": object_id,
                    "type": type_id or "Unknown",
                    "name": object_id,
                    "genericType": "unknown",
                    "parentId": None,
                    "visible": None,
                    "geometry": dict(EMPTY_GEOMETRY),
                    "properties": [],
                    "relationships": [],
                    "metadata": {},
                }

        return {
            "found": True,
            "rejected": False,
            "alreadySatisfied": False,
            "propertyChanges": [
                {"key": key, "before": before_values[key], "requested": changes[key], "after": after_values[key]} for key in changes
            ],
            "object": object_dict,
            "inspectionErrors": errors,
            "warnings": warnings,
        }
    finally:
        _close(doc)


def op_create_object(params):
    """Real geometry creation -- deliberately as narrow as
    op_modify_object's own SUPPORTED_MUTATIONS, and for the same reason:
    the only types this runner knows how to create SAFELY are the ones
    already fully validated for mutation in that same allowlist (same
    property bounds, same recompute-then-verify-then-save discipline) --
    currently Part::Box, Part::Cylinder and Part::Torus. A caller must
    name the TypeId exactly, matching FreeCAD's own real type name --
    never a generic "part"/"solid" label this script would have to guess
    a mapping for. Anything else is rejected honestly rather than
    silently coerced into some default shape.

    Mirrors op_modify_object's transaction-like safety exactly: every
    validation happens before doc.addObject() is ever called, and the
    document is never saved unless the resulting geometry actually
    recomputes into a valid shape -- a rejected or invalid-shape request
    leaves the on-disk file exactly as it was.
    """
    file_path = params["filePath"]
    type_id = params.get("type")
    name = params.get("name") or "Object"
    properties = params.get("properties") or {}

    allowed = SUPPORTED_MUTATIONS.get(type_id)
    if allowed is None:
        return _rejected(
            "unsupported_target_type",
            'Cannot create an object of type "%s" -- only %s is supported' % (type_id, ", ".join(SUPPORTED_MUTATIONS.keys())),
        )

    properties = _normalize_properties(type_id, properties)
    properties, placement = _split_placement(properties)
    placement_rejection = _validate_placement(placement)
    if placement_rejection is not None:
        return placement_rejection

    for key in properties:
        if key not in allowed:
            return _rejected("unsupported_property", 'Property "%s" is not supported when creating a "%s"' % (key, type_id))

    for key, value in properties.items():
        if not _is_finite_number(value):
            return _rejected("invalid_value", 'Value for "%s" must be a finite number (got %r)' % (key, value))
        constraints = allowed[key]
        if value < constraints["min"] or value > constraints["max"]:
            return _rejected(
                "value_out_of_range",
                '"%s" must be between %s and %s (got %s)' % (key, constraints["min"], constraints["max"], value),
            )

    doc = _open(file_path)
    try:
        # `addObject`'s second argument becomes the object's INTERNAL
        # `Name` (a bare identifier -- FreeCAD sanitizes it, e.g. hyphens
        # become underscores, confirmed empirically against a real
        # FreeCAD 1.1.3 install). `Label` is the separate, human-readable
        # field object_to_dict's own "name" mapping actually reports (see
        # its `label = getattr(obj, "Label", None) or obj.Name`) -- set
        # explicitly here so the caller's exact requested name is
        # preserved even when it isn't a valid bare identifier.
        obj = doc.addObject(type_id, name)
        obj.Label = name
        for key, value in properties.items():
            setattr(obj, key, value)
        _apply_placement(obj, placement)

        doc.recompute()

        # Do not assume addObject+setattr succeeded means creation
        # succeeded (same discipline as op_modify_object) -- verify the
        # RESULTING geometry before ever persisting it.
        shape = getattr(obj, "Shape", None)
        if shape is not None:
            try:
                shape_valid = bool(shape.isValid())
            except Exception:
                shape_valid = False
            if not shape_valid:
                # Never call doc.save() here -- remove the half-created
                # object from the in-memory document (a no-op on the
                # on-disk file, since it was never saved) so this function
                # never reports success for geometry that doesn't
                # genuinely, validly exist.
                doc.removeObject(obj.Name)
                return _rejected("invalid_resulting_geometry", "The requested object produced an invalid shape and was not saved")

        doc.save()

        # From here on the object has ALREADY been created and persisted --
        # matching op_modify_object's identical "never let a post-success
        # re-read failure erase proof of a real, saved, successful
        # creation" discipline. Every step below degrades to a warning.
        warnings = []
        errors = []
        try:
            object_dict = object_to_dict(obj, errors=errors)
        except Exception as error:
            warnings.append("Could not fully inspect the object after a successful, saved creation -- falling back to a lighter inspection: %s" % str(error))
            try:
                object_dict = object_to_dict(obj, include_geometry=False, errors=errors)
            except Exception as fallback_error:
                warnings.append("Falling back to a minimal object record: %s" % str(fallback_error))
                object_dict = {
                    "id": obj.Name,
                    "type": type_id,
                    "name": name,
                    "genericType": "unknown",
                    "parentId": None,
                    "visible": None,
                    "geometry": dict(EMPTY_GEOMETRY),
                    "properties": [],
                    "relationships": [],
                    "metadata": {},
                }

        return {
            "rejected": False,
            "object": object_dict,
            "inspectionErrors": errors,
            "warnings": warnings,
        }
    finally:
        _close(doc)


# The complete, fixed operation table -- see this module's docstring.
SUPPORTED_BOOLEANS = {
    "cut": "Part::Cut",
    "fuse": "Part::Fuse",
    "common": "Part::Common",
}

FILLET_RADIUS_BOUNDS = {"min": 0.001, "max": 10000.0}


def op_boolean_object(params):
    """Combines two existing solids into one, by subtraction, union or
    intersection.

    This is the operation that makes real shapes possible rather than only
    piles of primitives: a wheel arch is a cylinder CUT out of a body, a
    one-piece hull is a set of boxes FUSED together. Without it every
    assembly stays a loose collection of intersecting blocks.

    Deliberately as narrow as every other write here: the kind must be one
    of three named booleans, both operands must already exist in the
    document, and the result is only saved if it recomputes into a valid
    solid. Nothing about this lets a caller name an arbitrary FreeCAD
    type -- SUPPORTED_BOOLEANS is a closed table, exactly like
    SUPPORTED_MUTATIONS.

    FreeCAD consumes both operands: after a Cut, Base and Tool become
    children of the result and are no longer independently visible. That
    is FreeCAD's own model, not something this script chooses.
    """
    file_path = params["filePath"]
    kind = params.get("kind")
    base_id = params.get("baseId")
    tool_id = params.get("toolId")
    name = params.get("name") or "Boolean"

    type_id = SUPPORTED_BOOLEANS.get(kind)
    if type_id is None:
        return _rejected(
            "unsupported_target_type",
            'Unknown boolean "%s" -- only %s are supported' % (kind, ", ".join(sorted(SUPPORTED_BOOLEANS.keys()))),
        )

    doc = _open(file_path)
    try:
        base = doc.getObject(base_id)
        tool = doc.getObject(tool_id)
        if base is None:
            return {"found": False, "missing": base_id}
        if tool is None:
            return {"found": False, "missing": tool_id}

        obj = doc.addObject(type_id, name)
        obj.Label = name
        obj.Base = base
        obj.Tool = tool

        doc.recompute()

        shape = getattr(obj, "Shape", None)
        shape_valid = False
        if shape is not None:
            try:
                shape_valid = bool(shape.isValid())
            except Exception:
                shape_valid = False

        if not shape_valid:
            # Never persist a broken boolean -- a Cut that produces an
            # empty or self-intersecting solid leaves the file untouched.
            try:
                doc.removeObject(obj.Name)
                doc.recompute()
            except Exception:
                pass
            return _rejected("invalid_geometry", 'The "%s" produced no valid solid -- the document was not modified' % (kind,))

        doc.save()
        return {"found": True, "rejected": False, "object": object_to_dict(obj)}
    finally:
        _close(doc)


def op_fillet_object(params):
    """Rounds every edge of one solid by a single radius.

    Rounded edges are the single biggest difference between something that
    reads as a stack of blocks and something that reads as a designed
    object, which is why this exists as its own operation.

    Every edge is filleted by the same radius rather than exposing edge
    selection: naming individual edges would mean handing a caller
    FreeCAD's internal topological indices, which are unstable across
    recomputes and would be a far wider (and far less honest) interface
    than this script's allowlist model allows.

    A radius larger than the geometry can absorb makes FreeCAD produce an
    invalid shape; that is detected and rejected rather than saved.
    """
    file_path = params["filePath"]
    object_id = params.get("objectId")
    radius = params.get("radius")
    name = params.get("name") or "Fillet"

    if not _is_finite_number(radius):
        return _rejected("invalid_value", 'Fillet radius must be a finite number (got %r)' % (radius,))
    if radius < FILLET_RADIUS_BOUNDS["min"] or radius > FILLET_RADIUS_BOUNDS["max"]:
        return _rejected(
            "value_out_of_range",
            '"radius" must be between %s and %s (got %s)' % (FILLET_RADIUS_BOUNDS["min"], FILLET_RADIUS_BOUNDS["max"], radius),
        )

    doc = _open(file_path)
    try:
        base = doc.getObject(object_id)
        if base is None:
            return {"found": False, "missing": object_id}

        base_shape = getattr(base, "Shape", None)
        if base_shape is None:
            return _rejected("invalid_operation", "That object has no shape to fillet")

        edge_count = len(base_shape.Edges)
        if edge_count == 0:
            return _rejected("invalid_operation", "That object has no edges to fillet")

        obj = doc.addObject("Part::Fillet", name)
        obj.Label = name
        obj.Base = base
        # Edge indices here are 1-based and refer to the base shape as it
        # exists right now, which is why they are computed from that shape
        # rather than accepted from the caller.
        obj.Edges = [(index + 1, radius, radius) for index in range(edge_count)]

        doc.recompute()

        shape = getattr(obj, "Shape", None)
        shape_valid = False
        if shape is not None:
            try:
                shape_valid = bool(shape.isValid())
            except Exception:
                shape_valid = False

        if not shape_valid:
            try:
                doc.removeObject(obj.Name)
                doc.recompute()
            except Exception:
                pass
            # Deliberately does NOT blame the radius alone. Verified
            # empirically against real FreeCAD 1.1.3: a 20 mm fillet
            # succeeds on a plain box, while even 8 mm fails on a solid
            # produced by boolean cuts, because some of its edges (the
            # curved intersections a cut leaves behind) cannot all be
            # rounded at once. Saying "too large" there sent the caller
            # off shrinking the radius forever, which is exactly the kind
            # of confidently-wrong diagnosis this codebase avoids.
            return _rejected(
                "invalid_geometry",
                "Could not fillet every edge of that shape at %s mm -- the document was not modified. "
                "A smaller radius may work; on a solid produced by boolean cuts some edges cannot be "
                "filleted at any radius, so rounding it before cutting usually does." % (radius,),
            )

        doc.save()
        return {"found": True, "rejected": False, "object": object_to_dict(obj)}
    finally:
        _close(doc)


OPERATIONS = {
    "health": op_health,
    "connect": op_connect,
    "list_objects": op_list_objects,
    "inspect_object": op_inspect_object,
    "inspect_document": op_inspect_document,
    "create_object": op_create_object,
    "modify_object": op_modify_object,
    "boolean_object": op_boolean_object,
    "fillet_object": op_fillet_object,
    "save": op_save,
    "checkpoint": op_checkpoint,
    "restore": op_restore,
}


def main():
    response = None
    try:
        # Under `freecadcmd.exe runner.py <encoded>`, sys.argv is
        # [freecadcmd's own path, runner.py's path, <encoded>, ...] -- NOT
        # [runner.py's path, <encoded>, ...] the way a plain `python
        # runner.py <encoded>` invocation would set it up. Confirmed
        # empirically against a real FreeCAD 1.1.3 install (freecadcmd
        # keeps itself as argv[0] rather than replacing it with the
        # script). The encoded request is therefore argv[2].
        encoded_request = sys.argv[2]
        request = json.loads(base64.b64decode(encoded_request).decode("utf-8"))
        operation = request.get("operation")
        params = request.get("params") or {}
        handler = OPERATIONS.get(operation)
        if handler is None:
            response = {
                "status": "error",
                "kind": "invalid_operation",
                "message": "Unknown FreeCAD runner operation: %r" % (operation,),
            }
        else:
            try:
                data = handler(params)
                response = {"status": "success", "data": data}
            except Exception as error:
                sys.stderr.write(traceback.format_exc())
                response = {
                    "status": "error",
                    "kind": "environment_failure",
                    "message": "%s: %s" % (type(error).__name__, str(error)),
                }
    except Exception as outer_error:
        sys.stderr.write(traceback.format_exc())
        response = {
            "status": "error",
            "kind": "environment_failure",
            "message": "FreeCAD runner failure: %s" % (str(outer_error),),
        }

    sys.stdout.write(RESULT_PREFIX + json.dumps(response) + "\n")
    sys.stdout.flush()


# NOTE: freecadcmd imports this file as a regular module (its __name__ is
# the module's own filename, e.g. "runner", never "__main__") rather than
# executing it as a script entry point the way a plain `python runner.py`
# invocation would -- confirmed empirically against a real FreeCAD 1.1.3
# install. A `if __name__ == "__main__":` guard here would silently never
# fire under freecadcmd, so main() is called unconditionally: this module
# has exactly one purpose (being invoked this way) and is never meant to be
# imported as a library from anywhere else.
main()
