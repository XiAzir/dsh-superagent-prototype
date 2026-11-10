import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

from deploy.cnb import recovery


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.rules = Path(self.temp.name) / 'rules.json'
        self.rules.write_text(json.dumps({'allow_repos': [recovery.REPO], 'allow_branches': ['codex/autonomy-plan-20261107'], 'allow_events': ['vscode']}))
        self.env = {'CNB_IMPORT_RULES_FILE': str(self.rules), 'CNB_THRESH_RECYCLE': '1'}
        self.client = Mock()
        self.client.health.return_value = {'status': 'waiting'}
        self.client.running.return_value = []

    def test_health_and_receiver_failure_preserve_paused_and_do_not_touch_cnb(self):
        for health, status in [(None, 'receiver_unavailable'), ({'status': 'ok', 'paused': True}, 'healthy')]:
            self.client.health.return_value = health
            self.assertEqual(recovery.step(self.client, self.env, {})['status'], status)
            self.client.request.assert_not_called()
            self.client.running.assert_not_called()

    def test_branch_preflight_rejects_before_start(self):
        self.rules.write_text(json.dumps({'allow_repos': [recovery.REPO], 'allow_branches': ['linux'], 'allow_events': ['vscode']}))
        result = recovery.step(self.client, self.env, {})
        self.assertEqual(result['status'], 'blocked_import_branch')
        self.client.request.assert_not_called()

    def test_check_is_readonly_even_when_pending_build_failed(self):
        state = {'pending': 'cnb-abc-123'}
        self.client.build.return_value = {'status': 'blocked_import_branch'}
        before = dict(state)
        result = recovery.step(self.client, self.env, state, check=True)
        self.assertEqual(result['status'], 'blocked_import_branch')
        self.assertEqual(state, before)
        self.client.request.assert_not_called()

    def test_accepted_start_must_be_polled_and_does_not_mean_healthy(self):
        self.client.request.return_value = {'sn': 'cnb-abc-123'}
        self.client.build.return_value = {'status': 'starting', 'sn': 'cnb-abc-123'}
        state = {}
        result = recovery.step(self.client, self.env, state, now=10000)
        self.assertEqual(result['status'], 'starting')
        self.assertEqual(state['pending'], 'cnb-abc-123')
        self.client.build.assert_called_once_with('cnb-abc-123')
        self.client.request.reset_mock()
        recovery.step(self.client, self.env, state, now=10100)
        self.client.request.assert_not_called()

    def test_configuration_failure_is_remembered_and_retried_after_six_hours(self):
        state = {'pending': 'cnb-old-123', 'lastRequest': 10000}
        self.client.build.return_value = {'status': 'blocked_import_branch', 'sn': 'cnb-old-123'}
        result = recovery.step(self.client, self.env, state, now=20000)
        self.assertEqual(result['status'], 'blocked_import_branch')
        self.client.request.assert_not_called()
        self.client.request.return_value = {'sn': 'cnb-new-123'}
        recovery.step(self.client, self.env, state, now=41601)
        self.client.request.assert_called_once()
        self.assertEqual(state['pending'], 'cnb-new-123')

    def test_explicit_retry_releases_remembered_configuration_failure(self):
        state = {'pending': 'cnb-old-123', 'lastRequest': 10000, 'blockedAt': 10000}
        self.client.build.return_value = {'status': 'blocked_import_branch'}
        self.client.request.return_value = {'sn': 'cnb-new-123'}
        recovery.step(self.client, self.env, state, now=10001, retry_blocked=True)
        self.assertEqual(state['pending'], 'cnb-new-123')

    def test_build_diagnostic_uses_prepare_stage_and_keeps_secret_log_out_of_result(self):
        client = recovery.Client({})
        client.request = Mock(side_effect=[{'status': 'error', 'pipelinesStatus': {'cnb-abc-123-001': {'stages': [{'id': 'prepare', 'status': 'error'}]}}}, {'error': 'branch does not conform to allow_branches SECRET-VALUE'}])
        result = client.build('cnb-abc-123')
        self.assertEqual(result['status'], 'blocked_import_branch')
        self.assertEqual(result['stage'], 'prepare')
        self.assertNotIn('SECRET-VALUE', json.dumps(result))

    def test_duplicate_workspaces_prevent_mutation(self):
        self.client.running.return_value = [{'sn': 'cnb-a-123'}, {'sn': 'cnb-b-123'}]
        self.assertEqual(recovery.step(self.client, self.env, {})['status'], 'multiple_workspaces')
        self.client.request.assert_not_called()

    def test_healthy_running_workspace_completes_pending_recovery(self):
        state = {'pending': 'cnb-a-123', 'failures': 2}
        self.client.health.return_value = {'status': 'ok', 'confirmed': True, 'owner': 'cnb-a-123-001'}
        self.client.running.return_value = [{'sn': 'cnb-a-123'}]
        result = recovery.step(self.client, self.env, state)
        self.assertEqual(result['status'], 'healthy')
        self.assertEqual(state, {})

    def test_health_without_matching_running_workspace_preserves_pending_recovery(self):
        state = {'pending': 'cnb-a-123'}
        self.client.health.return_value = {'status': 'ok', 'confirmed': True, 'owner': 'cnb-a-123-001'}
        result = recovery.step(self.client, self.env, state)
        self.assertEqual(result['status'], 'health_ok_workspace_unverified')
        self.assertEqual(state['pending'], 'cnb-a-123')
        self.client.request.assert_not_called()

    def test_bootstrap_health_does_not_complete_recovery(self):
        state = {'pending': 'cnb-a-123'}
        self.client.health.return_value = {'status': 'ok', 'confirmed': False}
        self.assertEqual(recovery.step(self.client, self.env, state)['status'], 'bootstrapping')
        self.assertEqual(state['pending'], 'cnb-a-123')
        self.client.request.assert_not_called()

    def test_receiver_summary_requires_fresh_owned_healthy_heartbeat(self):
        path = Path(self.temp.name) / 'state.json'
        base = {'lease': {'owner': 'cnb-a-123-001', 'expires_at': 1100}, 'heartbeat': {'owner': 'cnb-a-123-001', 'at': 990, 'healthy': True}}
        path.write_text(json.dumps(base))
        self.assertTrue(recovery.receiver_summary(path, 1000)['confirmed'])
        for heartbeat in [None, {'owner': 'old', 'at': 990, 'healthy': True}, {'owner': 'cnb-a-123-001', 'at': 800, 'healthy': True}, {'owner': 'cnb-a-123-001', 'at': 990, 'healthy': False}, {'owner': 'cnb-a-123-001', 'at': 990, 'healthy': True, 'stage': 'shutting_down'}]:
            path.write_text(json.dumps({**base, 'heartbeat': heartbeat}))
            self.assertFalse(recovery.receiver_summary(path, 1000)['confirmed'])

    def test_rule_snapshot_accepts_allow_slugs(self):
        self.rules.write_text(json.dumps({'allow_slugs': [recovery.REPO], 'allow_branches': ['codex/*'], 'allow_events': ['vscode']}))
        self.assertIsNone(recovery.import_rule_issue(self.rules, 'codex/autonomy-plan-20261107'))

    def test_migrated_linux_workspace_is_included_for_codex_recovery(self):
        client = recovery.Client({})
        client.request = Mock(return_value={'list': [{'slug': recovery.REPO, 'branch': 'linux', 'status': 'running', 'sn': 'cnb-a-123'}, {'slug': 'other/repo', 'branch': 'linux', 'status': 'running', 'sn': 'cnb-b-123'}]})
        self.assertEqual([row['sn'] for row in client.running('codex/autonomy-plan-20261107')], ['cnb-a-123'])

    def test_stalled_accepted_build_recycles_after_thirty_minutes(self):
        state = {'pending': 'cnb-a-123', 'lastRequest': 10000}
        self.client.build.return_value = {'status': 'starting', 'sn': 'cnb-a-123'}
        self.client.running.return_value = [{'sn': 'cnb-a-123'}]
        self.client.request.return_value = {'success': True}
        result = recovery.step(self.client, self.env, state, now=11801)
        self.assertEqual(result['status'], 'stopping_unhealthy_workspace')
        self.assertNotIn('pending', state)
        self.assertIn('/build/stop/cnb-a-123', self.client.request.call_args.args[0])

    def test_missing_receiver_state_prevents_recovery(self):
        self.client.health.return_value = {'status': 'waiting', 'receiverStateUnavailable': True}
        self.assertEqual(recovery.step(self.client, self.env, {})['status'], 'receiver_state_unavailable')
        self.client.request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
