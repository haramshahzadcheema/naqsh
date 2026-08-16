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


def get_relationships(obj):
    """Only FreeCAD-reported dependency links (OutList) are exposed -- see
    Phase 12 Step 9: represent a relationship only where the environment
    provides reliable information, never fabricate one."""
    relationships = []
    try:
        out_list = obj.OutList
    except Exception:
        out_list = []
    for other in out_list:
        try:
            relationships.append({"type": "references", "targetId": other.Name, "metadata": {}})
        except Exception:
            continue
    return relationships


def object_to_dict(obj):
    label = getattr(obj, "Label", None) or obj.Name
    return {
        "id": obj.Name,
        "type": getattr(obj, "TypeId", "Unknown"),
        "name": label,
        "properties": get_properties(obj),
        "relationships": get_relationships(obj),
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
    file_path = params["filePath"]
    doc = _open(file_path)
    try:
        return {"objects": [object_to_dict(obj) for obj in doc.Objects]}
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
        return {"found": True, "object": object_to_dict(obj)}
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
