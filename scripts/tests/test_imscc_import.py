import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "setup-knowledge-base.py"
CANVAS_EXPORT = Path(__file__).resolve().parent / "fixtures" / "canvas-biology-101.imscc"
SPEC = importlib.util.spec_from_file_location("setup_knowledge_base", SCRIPT)
assert SPEC and SPEC.loader
setup_knowledge_base = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(setup_knowledge_base)


class IMSCCImportTests(unittest.TestCase):
    def create_package(self, files: dict[str, str]) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        package = Path(directory.name) / "course.imscc"
        with zipfile.ZipFile(package, "w") as archive:
            for name, content in files.items():
                archive.writestr(name, content)
        return package

    def test_imports_canvas_html_and_assignment_content_from_manifest_resources(self) -> None:
        documents = setup_knowledge_base.load_imscc_documents(CANVAS_EXPORT)

        self.assertEqual(
            documents,
            [
                {
                    "id": documents[0]["id"],
                    "title": "wiki-page-week-1",
                    "content": "Week 1 overview Week 1: Cells Review the cell theory before class.",
                    "subject": "Biology 101",
                    "url": "imscc://canvas-biology-101/wiki_content/week_1_overview.html",
                },
                {
                    "id": documents[1]["id"],
                    "title": "assignment-cell-observation",
                    "content": "Cell observation Observe one prepared specimen and submit your notes. 10",
                    "subject": "Biology 101",
                    "url": "imscc://canvas-biology-101/assignment_settings/cell_observation.xml",
                },
            ],
        )
        self.assertTrue(documents[0]["id"].startswith("imscc-"))

    def test_requires_an_imscc_manifest(self) -> None:
        package = self.create_package({"wiki_content/week_1.html": "<p>Cells</p>"})

        with self.assertRaisesRegex(ValueError, "imsmanifest.xml"):
            setup_knowledge_base.load_imscc_documents(package)


if __name__ == "__main__":
    unittest.main()
