import json
from validators import is_valid_age, is_valid_name

checks = {
    'age_zero': is_valid_age(0),
    'age_34': is_valid_age(34),
    'age_120': is_valid_age(120),
    'age_121': is_valid_age(121),
    'two_word_name': is_valid_name('سعاد حسن'),
    'single_word_name': is_valid_name('محمود'),
    'two_arbitrary_words': is_valid_name('not identity'),
}
assert checks == {'age_zero': False, 'age_34': True, 'age_120': True, 'age_121': False, 'two_word_name': True, 'single_word_name': False, 'two_arbitrary_words': True}
print('BOUNDARY_CHECKS=' + json.dumps(checks, ensure_ascii=False, sort_keys=True))
