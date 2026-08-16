"""
Builds a minimal FreeCAD document with a REAL, FreeCAD-reported dependency
relationship (Phase 12 Step 9's "reading relationships where supported"),
for freecad-adapter.integration.test.ts's relationship-mapping test.

A Part::Cut referencing two Part::Box objects via Base/Tool always reports
both in its own `OutList` -- confirmed empirically against a real FreeCAD
1.1.3 install. Invoked exactly like runner.py/build_fixture.py:
`freecadcmd build_relationship_fixture.py <output_path>` (output path is
argv[2] -- see runner.py's doc comment for why).
"""

import sys

import FreeCAD

output_path = sys.argv[2]

doc = FreeCAD.newDocument("NaqshRelationshipFixture")
box1 = doc.addObject("Part::Box", "Box1")
box2 = doc.addObject("Part::Box", "Box2")
box2.Placement.Base = FreeCAD.Vector(5, 0, 0)
cut = doc.addObject("Part::Cut", "Cut")
cut.Base = box1
cut.Tool = box2
doc.recompute()
doc.saveAs(output_path)
FreeCAD.closeDocument(doc.Name)

sys.stdout.write("FIXTURE_BUILT:" + output_path + "\n")
sys.stdout.flush()
