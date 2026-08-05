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

    def test_uses_subject_override_and_skips_empty_missing_and_duplicate_resources(self) -> None:
        package = self.create_package(
            {
                "imsmanifest.xml": """<manifest>
                  <metadata><title>Default course title</title></metadata>
                  <resources>
                    <resource identifier="overview" href="pages/overview.txt"/>
                    <resource identifier="duplicate"><file href="pages/overview.txt"/></resource>
                    <resource identifier="empty"><file href="pages/empty.html"/></resource>
                    <resource identifier="missing"><file href="pages/missing.html"/></resource>
                  </resources>
                </manifest>""",
                "pages/overview.txt": "Read chapter one.",
                "pages/empty.html": "<p>  </p>",
            }
        )

        documents = setup_knowledge_base.load_imscc_documents(package, subject="Override course")

        self.assertEqual(
            documents,
            [
                {
                    "id": documents[0]["id"],
                    "title": "overview",
                    "content": "Read chapter one.",
                    "subject": "Override course",
                    "url": "imscc://course/pages/overview.txt",
                }
            ],
        )

    def test_rejects_invalid_archives_and_manifests_without_course_content(self) -> None:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        not_an_archive = Path(directory.name) / "not-an-archive.imscc"
        not_an_archive.write_text("not a zip archive", encoding="utf-8")
        empty_manifest = self.create_package({"imsmanifest.xml": "<manifest><resources/></manifest>"})

        with self.assertRaisesRegex(ValueError, "not a ZIP archive"):
            setup_knowledge_base.load_imscc_documents(not_an_archive)
        with self.assertRaisesRegex(ValueError, "No text course content"):
            setup_knowledge_base.load_imscc_documents(empty_manifest)


if __name__ == "__main__":
    unittest.main()
