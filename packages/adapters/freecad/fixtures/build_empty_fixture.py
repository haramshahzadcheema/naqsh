"""
Builds a genuinely empty FreeCAD document -- for
freecad-adapter.integration.test.ts's Phase 13 Step 18 test that an empty
document is a valid, non-crashing inspection target (not just a
never-exercised assumption). Invoked exactly like every other fixture
builder in this directory: `freecadcmd build_empty_fixture.py <output_path>`
(output path is argv[2] -- see runner.py's doc comment for why).
"""

import sys

import FreeCAD

output_path = sys.argv[2]

doc = FreeCAD.newDocument("NaqshEmptyFixture")
doc.saveAs(output_path)
FreeCAD.closeDocument(doc.Name)

sys.stdout.write("FIXTURE_BUILT:" + output_path + "\n")
sys.stdout.flush()
