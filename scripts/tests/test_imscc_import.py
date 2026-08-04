import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "setup-knowledge-base.py"
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

    def test_imports_html_and_assignment_content_from_manifest_resources(self) -> None:
        package = self.create_package(
            {
                "imsmanifest.xml": """<manifest>
                  <metadata><title>Biology 101</title></metadata>
                  <resources>
                    <resource identifier="page"><title>Week 1</title><file href="wiki_content/week_1.html"/></resource>
                    <resource identifier="assignment"><title>Lab report</title><file href="assignments/lab.xml"/></resource>
                  </resources>
                </manifest>""",
                "wiki_content/week_1.html": "<h1>Cells</h1><p>Cells are alive.</p><script>ignore()</script>",
                "assignments/lab.xml": "<assignment><instructions>Observe a specimen.</instructions></assignment>",
            }
        )

        documents = setup_knowledge_base.load_imscc_documents(package)

        self.assertEqual(
            documents,
            [
                {
                    "id": documents[0]["id"],
                    "title": "Week 1",
                    "content": "Cells Cells are alive.",
                    "subject": "Biology 101",
                    "url": "imscc://course/wiki_content/week_1.html",
                },
                {
                    "id": documents[1]["id"],
                    "title": "Lab report",
                    "content": "Observe a specimen.",
                    "subject": "Biology 101",
                    "url": "imscc://course/assignments/lab.xml",
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
