"""用真实 Git 引用验证候选冻结。测试不访问网络。"""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from candidate_remote import freeze_candidate_ref, verify_candidate_ref


class CandidateRemoteTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.remote = Path(directory.name) / 'remote'
        self.client = Path(directory.name) / 'facility'
        self.remote.mkdir()
        self.client.mkdir()
        self.git(self.remote, 'init', '-q', '--initial-branch=work')
        self.git(self.remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'candidate')
        self.commit = self.git(self.remote, 'rev-parse', 'HEAD')
        self.git(self.remote, 'branch', 'develop', self.commit)
        self.git(self.remote, '-c', 'tag.gpgSign=false', 'tag', 'preview', self.commit)
        self.git(self.remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 '-c', 'tag.gpgSign=false', 'tag', '-a', 'annotated-preview', '-m', 'tag object', self.commit)
        self.git(self.client, 'init', '-q')
        self.git(self.client, 'remote', 'add', 'origin', str(self.remote))
        self.files = [{'path': 'src/main.ts', 'sha256': '1' * 64}]
        self.source_hash = hashlib.sha256(json.dumps(
            self.files, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        self.identity = {'candidate': self.commit, 'sourceHash': self.source_hash}
        self.candidate = {**self.identity, 'branch': 'codex/archived-fixture'}
        self.source = {'kind': 'candidate', 'commit': self.commit,
                       'sourceHash': self.source_hash, 'files': self.files}

    @staticmethod
    def git(repo, *args):
        return subprocess.check_output(['git', *args], cwd=repo, text=True).strip()

    def freeze(self, ref):
        auth = {'candidateRef': ref, 'candidateIdentity': self.identity.copy()}
        proof = freeze_candidate_ref(self.client, auth, self.identity, self.candidate, self.source)
        manifest = {'identities': self.identity, 'candidateGit': proof}
        verify_candidate_ref(auth, manifest)
        return auth, manifest

    def test_branch_uses_registered_ref(self):
        _, manifest = self.freeze('refs/heads/develop')
        self.assertEqual(manifest['candidateGit'], {
            'ref': 'refs/heads/develop', 'object': self.commit,
            'commit': self.commit, 'sourceHash': self.source_hash,
        })
        self.assertEqual(self.git(self.remote, 'for-each-ref', 'refs/heads/codex/archived-fixture'), '')

    def test_lightweight_tag(self):
        _, manifest = self.freeze('refs/tags/preview')
        self.assertEqual(manifest['candidateGit']['object'], self.commit)

    def test_annotated_tag_retains_tag_object_and_commit(self):
        _, manifest = self.freeze('refs/tags/annotated-preview')
        tag = self.git(self.remote, 'rev-parse', 'refs/tags/annotated-preview')
        self.assertNotEqual(tag, self.commit)
        self.assertEqual(manifest['candidateGit']['object'], tag)
        self.assertEqual(manifest['candidateGit']['commit'], self.commit)

    def test_same_suffix_ref_cannot_stand_in_for_missing_ref(self):
        self.git(self.remote, 'update-ref', 'refs/heads/mirror/refs/tags/missing', self.commit)
        with self.assertRaisesRegex(ValueError, '缺少本批候选引用'):
            self.freeze('refs/tags/missing')

    def test_branch_moved_after_candidate_was_defined(self):
        self.git(self.remote, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                 'commit', '-q', '--allow-empty', '--no-gpg-sign', '-m', 'later')
        self.git(self.remote, 'branch', '-f', 'develop', 'HEAD')
        with self.assertRaisesRegex(ValueError, '未指向本批冻结提交'):
            self.freeze('refs/heads/develop')

    def test_rejects_missing_or_unqualified_candidate_ref(self):
        for ref in (None, 'develop', 'HEAD', 'refs/pull/1/head', 'refs/tags/*', 'refs/tags/'):
            with self.subTest(ref=ref), self.assertRaisesRegex(ValueError, '完整的候选引用'):
                self.freeze(ref)

    def test_rejects_mismatched_checkout_and_source_inventory(self):
        self.candidate['candidate'] = 'f' * 40
        with self.assertRaisesRegex(ValueError, '候选提交或源码哈希'):
            self.freeze('refs/tags/preview')
        self.candidate['candidate'] = self.commit
        self.source['files'] = [{'path': 'src/other.ts', 'sha256': '2' * 64}]
        with self.assertRaisesRegex(ValueError, '候选源码清单'):
            self.freeze('refs/tags/preview')

    def test_rejects_mismatched_authorized_identity(self):
        auth = {'candidateRef': 'refs/tags/preview',
                'candidateIdentity': {**self.identity, 'sourceHash': 'f' * 64}}
        with self.assertRaisesRegex(ValueError, '候选提交或源码哈希'):
            freeze_candidate_ref(self.client, auth, self.identity, self.candidate, self.source)

    def test_remote_unavailable(self):
        self.git(self.client, 'remote', 'set-url', 'origin', str(self.remote / 'absent'))
        with self.assertRaisesRegex(ValueError, '无法查询 origin'):
            self.freeze('refs/tags/preview')

    def test_audit_uses_frozen_evidence_after_ref_goes_away(self):
        auth, manifest = self.freeze('refs/heads/develop')
        self.git(self.remote, 'update-ref', '-d', 'refs/heads/develop')
        verify_candidate_ref(auth, manifest)

    def test_rejects_missing_or_changed_frozen_evidence(self):
        auth, manifest = self.freeze('refs/heads/develop')
        for field, value in (('ref', 'refs/heads/other'), ('commit', 'f' * 40),
                             ('object', 'f' * 40), ('sourceHash', 'f' * 64)):
            mutated = deepcopy(manifest)
            mutated['candidateGit'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_candidate_ref(auth, mutated)
        with self.assertRaises(ValueError):
            verify_candidate_ref(auth, {'identities': self.identity})
        with self.assertRaises(ValueError):
            verify_candidate_ref({}, manifest)

    def test_legacy_sealed_manifest(self):
        verify_candidate_ref({'candidateIdentity': self.identity}, {'identities': self.identity})


if __name__ == '__main__':
    unittest.main()
