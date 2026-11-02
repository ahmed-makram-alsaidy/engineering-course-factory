# -*- coding: utf-8 -*-
import unittest

from validators import is_valid_age, is_valid_name


class TestFunctions(unittest.TestCase):
    def test_age_gate(self):
        self.assertTrue(is_valid_age(34))
        self.assertFalse(is_valid_age(999))
        self.assertFalse(is_valid_age(-1))

    def test_name_gate(self):
        self.assertTrue(is_valid_name("سعاد حسن"))
        self.assertFalse(is_valid_name("محمود"))


if __name__ == "__main__":
    unittest.main()
