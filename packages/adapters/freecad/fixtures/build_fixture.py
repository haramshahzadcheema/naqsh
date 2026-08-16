"""
Builds a minimal, deterministic FreeCAD document for Phase 12's LEVEL 2
integration tests (packages/adapters/test/freecad-adapter.integration.test.ts).

Invoked exactly like runner.py: `freecadcmd build_fixture.py <output_path>`.
Because freecadcmd keeps itself as argv[0], the output path is argv[2] (see
runner.py's own doc comment for why). Deliberately NOT complicated CAD --
Phase 12 Step 16 asks for a minimal, known object, not a real model: one
Part::Box, with a genuinely writable property (Length) so both this
project's own tests and the reusable EnvironmentAdapter contract-test
suite (which requires at least one writable property to exercise the
"modify capability" check) have something real to inspect.
"""

import sys

import FreeCAD

output_path = sys.argv[2]

doc = FreeCAD.newDocument("NaqshFixture")
box = doc.addObject("Part::Box", "Box")
box.Label = "Fixture Box"
box.Length = 10
box.Width = 10
box.Height = 10
doc.recompute()
doc.saveAs(output_path)
FreeCAD.closeDocument(doc.Name)

sys.stdout.write("FIXTURE_BUILT:" + output_path + "\n")
sys.stdout.flush()
