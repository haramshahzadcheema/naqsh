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
import traceback

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
    properties = []
    try:
        names = list(obj.PropertiesList)
    except Exception:
        names = []
    for name in names:
        try:
            editor_mode = set(obj.getEditorMode(name))
            read_only = bool(editor_mode & NON_WRITABLE_EDITOR_MODES)
        except Exception:
            read_only = False
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


# The complete, fixed operation table -- see this module's docstring.
OPERATIONS = {
    "health": op_health,
    "connect": op_connect,
    "list_objects": op_list_objects,
    "inspect_object": op_inspect_object,
    "inspect_document": op_inspect_document,
    "save": op_save,
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
