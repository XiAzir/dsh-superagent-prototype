import unittest

from deploy.cnb.qq_backend import QQBackend, QQBackendError


class Bridge:
    def __init__(self, name, events, enabled=False):
        self.name, self.events, self.enabled = name, events, enabled
        self.running = False

    def configured(self): return self.enabled
    def healthy(self): return self.running

    def ensure_started(self):
        self.events.append(('start', self.name))
        self.running = True
        return {'enabled': True, 'running': True, 'webui_ready': True, 'login': 'pending'}

    def stop(self, **_kwargs):
        self.events.append(('stop', self.name))
        self.running = False
        return True


class QQBackendTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.napcat = Bridge('napcat', self.events)
        self.snowluma = Bridge('snowluma', self.events)
        self.backend = QQBackend(self.napcat, self.snowluma)

    def test_disabled_does_not_touch_containers(self):
        self.assertFalse(self.backend.configured())
        self.assertFalse(self.backend.ensure_started()['enabled'])
        self.assertTrue(self.backend.healthy())
        self.assertFalse(self.backend.stop())
        self.assertEqual(self.events, [])

    def test_snowluma_stops_old_napcat_before_binding_port(self):
        self.napcat.running = True
        self.snowluma.enabled = True
        result = self.backend.ensure_started()
        self.assertEqual(self.events, [('stop', 'napcat'), ('start', 'snowluma')])
        self.assertEqual(result['backend'], 'snowluma')
        self.assertTrue(self.backend.healthy())

    def test_rejects_two_enabled_bridges_before_starting(self):
        self.napcat.enabled = self.snowluma.enabled = True
        with self.assertRaises(QQBackendError): self.backend.ensure_started()
        self.assertEqual(self.events, [])

    def test_switching_back_stops_snowluma_first(self):
        self.snowluma.enabled = True
        self.backend.ensure_started()
        self.events.clear()
        self.snowluma.enabled, self.napcat.enabled = False, True
        self.backend.ensure_started()
        self.assertEqual(self.events, [('stop', 'snowluma'), ('start', 'napcat')])

    def test_disabling_active_bridge_stops_it(self):
        self.snowluma.enabled = True
        self.backend.ensure_started()
        self.events.clear()
        self.snowluma.enabled = False
        self.assertFalse(self.backend.healthy())
        self.assertFalse(self.backend.ensure_started()['enabled'])
        self.assertTrue(self.backend.healthy())
        self.assertEqual(self.events, [('stop', 'snowluma')])

    def test_stop_attempts_both_enabled_bridges_even_when_one_fails(self):
        self.napcat.enabled = self.snowluma.enabled = True
        def fail(**_kwargs): raise RuntimeError('private detail')
        self.napcat.stop = fail
        with self.assertRaises(QQBackendError) as error: self.backend.stop()
        self.assertNotIn('private detail', str(error.exception))
        self.assertEqual(self.events, [('stop', 'snowluma')])
