"""canon.py against every row of the key table in references/schema.md.

    python -B -m unittest discover -s <skills>/research-pipeline/tests -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
from canon import item_key, source_url  # noqa: E402

KEYS = [
    ("https://github.com/Browser-Use/browser-use/tree/main/docs", None, "github:browser-use/browser-use"),
    ("github.com/karpathy", None, "github:karpathy"),
    ("https://www.instagram.com/Nick_Saraev/?igsh=abc", None, "instagram:nick_saraev"),
    ("https://www.instagram.com/nick_saraev/p/DAbC-12_x/", None, "instagram:p/DAbC-12_x"),
    ("https://instagram.com/reel/DAbC-12_x/?utm_source=ig_web", None, "instagram:p/DAbC-12_x"),
    ("https://youtu.be/dQw4w9WgXcQ?si=xyz", None, "youtube:v/dQw4w9WgXcQ"),
    ("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42s&feature=share", None, "youtube:v/dQw4w9WgXcQ"),
    ("https://www.youtube.com/shorts/dQw4w9WgXcQ", None, "youtube:v/dQw4w9WgXcQ"),
    ("https://www.youtube.com/@NickSaraev/videos", None, "youtube:@nicksaraev"),
    ("https://www.youtube.com/channel/UCabcDEF123", None, "youtube:channel/UCabcDEF123"),
    ("https://t.me/AIEdu/1234", None, "telegram:aiedu/1234"),
    ("https://t.me/AIEdu", None, "telegram:aiedu"),
    ("https://twitter.com/karpathy/status/1234567?s=20", None, "x:status/1234567"),
    ("https://arxiv.org/pdf/2401.01234v3.pdf", None, "arxiv:2401.01234"),
    ("https://doi.org/10.1145/ABC.123", None, "doi:10.1145/abc.123"),
    ("https://huggingface.co/datasets/OpenAssistant/oasst1/viewer", None, "hf:datasets/OpenAssistant/oasst1"),
    ("https://www.kaggle.com/datasets/Owner/Name", None, "kaggle:owner/name"),
    ("https://www.Example.com/Blog/Post/?utm_campaign=x#top", None, "web:example.com/Blog/Post"),
    ("https://shop.example.com/item?id=7&utm_source=x", None, "web:shop.example.com/item?id=7"),
    ("https://www.example.com/pricing", "org", "web:example.com"),
    ("https://www.instagram.com/nick_saraev/", "person", "person:nick_saraev"),
    ("https://www.youtube.com/@NickSaraev", "person", "person:nicksaraev"),
]

URLS = [
    ("https://youtu.be/dQw4w9WgXcQ?si=xyz", "https://youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://www.instagram.com/nick_saraev/reel/DAbC-12_x/?igsh=1", "https://instagram.com/p/DAbC-12_x"),
    ("http://WWW.Example.com/a//b/?b=2&a=1&utm_medium=x#frag", "https://example.com/a/b?a=1&b=2"),
    ("example.com", "https://example.com"),
]


class CanonTest(unittest.TestCase):
    def test_keys(self):
        for url, kind, want in KEYS:
            with self.subTest(url=url):
                self.assertEqual(item_key(url, kind), want)

    def test_source_urls(self):
        for url, want in URLS:
            with self.subTest(url=url):
                self.assertEqual(source_url(url), want)

    def test_same_thing_same_key(self):
        forms = ["https://youtu.be/dQw4w9WgXcQ", "youtube.com/watch?v=dQw4w9WgXcQ&list=PL1",
                 "https://www.youtube.com/live/dQw4w9WgXcQ"]
        self.assertEqual({item_key(u) for u in forms}, {"youtube:v/dQw4w9WgXcQ"})

    def test_person_needs_an_account(self):
        with self.assertRaises(ValueError):
            item_key("https://github.com/karpathy/nanoGPT", "person")


if __name__ == "__main__":
    unittest.main()
