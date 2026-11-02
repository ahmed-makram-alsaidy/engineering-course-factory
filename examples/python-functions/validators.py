# -*- coding: utf-8 -*-
# C02.09 - Functions: الفحوصات المتكررة تصبح دوال
def is_valid_age(age):
    """0 < age <= 120"""
    return isinstance(age, int) and 0 < age <= 120


def is_valid_name(name):
    """كلمتان على الأقل بعد التنضيف."""
    return isinstance(name, str) and len(name.strip().split()) >= 2


print(f"FUNC_VALID_AGE_TRUE={str(is_valid_age(34)).lower()}")
print(f"FUNC_INVALID_AGE_FALSE={str(not is_valid_age(999)).lower()}")
print(f"FUNC_NAME_RULE_OK={str(is_valid_name('سعاد حسن')).lower()}")
print(f"FUNC_SINGLE_WORD_REJECTED={str(not is_valid_name('محمود')).lower()}")
