import importlib.util
import json
from pathlib import Path
import struct
import unittest

spec = importlib.util.spec_from_file_location('import_emotes', Path(__file__).with_name('import-emotes.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def archive(name='a.json', payload=b'{}'):
    record = bytearray(256)
    encoded = name.encode()
    record[0] = len(encoded)
    record[1:1+len(encoded)] = encoded
    struct.pack_into('<II', record, 248, 0, len(payload))
    return module.MAGIC + struct.pack('<II', 1, 1) + record + payload


class ImportTests(unittest.TestCase):
    def test_native_archive_data_offsets(self):
        self.assertEqual(module.read_brarchive(archive()), {'a.json': b'{}'})

    def test_reject_truncation_traversal_and_bad_version(self):
        for data in [archive()[:-1], archive('../a'), b'bad', archive()[:12] + struct.pack('<I', 2) + archive()[16:]]:
            with self.assertRaises(ValueError):
                module.read_brarchive(data)

    def test_metadata_is_authoritative_and_bytes_are_unchanged(self):
        doc = {'animations': {'animation.fixture': {'bones': {'head': {'rotation': [1, 2, 3]}}}}}
        meta = {'piece_id': '00000000-0000-0000-0000-000000000001', 'piece_type': 'persona_emote',
                'piece_name': 'fixture', 'animation_sources': [{'name': 'animation.fixture', 'animationFile': 'motion.json'}]}
        entries = {'nested/item.meta.json': json.dumps(meta).encode(), 'nested/motion.json': json.dumps(doc).encode()}
        result, row = module.collect_package(entries, 'fixture', 'abc')
        self.assertEqual(result[0]['document'], doc)
        self.assertEqual(result[0]['id'], meta['piece_id'])
        self.assertEqual(row['status'], 'imported')
        meta['animation_sources'][0]['name'] = 'missing'
        entries['nested/item.meta.json'] = json.dumps(meta).encode()
        self.assertEqual(module.collect_package(entries, 'fixture', 'abc')[0], [])

    def test_unreadable_package_is_not_playable(self):
        result, row = module.collect_package({'item.meta.json': b'\xff\x00'}, 'fixture', 'abc')
        self.assertEqual(result, [])
        self.assertEqual(row['status'], 'unreadable_metadata')


if __name__ == '__main__':
    unittest.main()
