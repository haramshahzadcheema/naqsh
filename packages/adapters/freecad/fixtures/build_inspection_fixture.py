"""
Builds a richer FreeCAD document exercising Phase 13's inspection surface:
containment (a Group and an App::Part each with a child), a link
(App::Link), a dependency (Part::Cut's Base/Tool), and a sketch (a Shape
that exists but is invalid) -- for freecad-adapter.integration.test.ts's
Phase 13 tests. Every relationship/hierarchy fact this fixture encodes was
confirmed empirically against a real FreeCAD 1.1.3 install before writing
runner.py's corresponding inspection logic (see runner.py's own comments).

Invoked exactly like build_fixture.py/build_relationship_fixture.py:
`freecadcmd build_inspection_fixture.py <output_path>` (output path is
argv[2] -- see runner.py's doc comment for why).
"""

import sys

import FreeCAD

output_path = sys.argv[2]

doc = FreeCAD.newDocument("NaqshInspectionFixture")

group = doc.addObject("App::DocumentObjectGroup", "Group")
part = doc.addObject("App::Part", "Assembly")
box1 = doc.addObject("Part::Box", "Box1")
box2 = doc.addObject("Part::Box", "Box2")
box2.Placement.Base = FreeCAD.Vector(5, 0, 0)
group.addObject(box1)
part.addObject(box2)

cut = doc.addObject("Part::Cut", "Cut")
cut.Base = box1
cut.Tool = box2

sketch = doc.addObject("Sketcher::SketchObject", "Sketch")

link = doc.addObject("App::Link", "MyLink")
link.LinkedObject = box1

doc.recompute()
doc.saveAs(output_path)
FreeCAD.closeDocument(doc.Name)

sys.stdout.write("FIXTURE_BUILT:" + output_path + "\n")
sys.stdout.flush()
