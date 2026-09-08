-- Chakudya Nutrition Registry
-- Migration: Expand food_synonyms with terms mined from the authoritative
-- Malawi Food Composition Table source (the CSV `foods` was seeded from).
--
-- 009's synonym seed was written from general knowledge and was mostly
-- right, but had a couple of real mistakes (e.g. 'thabwa' for pumpkin —
-- the FCT's actual term is 'Dzungu') and missed a lot of vocabulary that's
-- genuinely in the source data: more vegetables, fruits, fish species by
-- local name, and the insect/wild-food staples (locust, caterpillar, lake
-- flies, termites) that didn't have any synonym coverage at all. This
-- migration adds those, all via plain INSERT ... ON CONFLICT DO NOTHING —
-- no schema changes, safe to re-run.
--
-- Note: most of these Chichewa terms are ALREADY directly searchable via
-- fuzzy_food_search()/autocomplete_food_names() without any synonym
-- expansion, because food_name embeds them in parentheses (e.g. "Fish,
-- tilapia, ..., (Chambo cha fuleshi)" — searching "chambo" already matches
-- that row directly). The synonym table's job is query EXPANSION: entering
-- one term also searches related ones, so e.g. a search for "watermelon"
-- also re-runs the search for "mavwende", surfacing the FCT row even
-- though "watermelon" the English word doesn't appear in food_name at all
-- (only "Watermelon, raw, peeled" does — that one's fine on its own — but
-- generic English category words like "fish" benefit from expanding out to
-- every local species name).

insert into public.food_synonyms (group_key, term, language) values
  -- correction: pumpkin's actual FCT term is Dzungu, not the 'thabwa' I
  -- guessed in 009 — adding it here rather than removing the old row,
  -- since 'thabwa' is still a real regional word and harmless to keep.
  ('pumpkin',        'dzungu', 'ny'),
  ('avocado',         'peyala', 'ny'),

  -- vegetables not covered in 009
  ('cabbage',         'kabichi', 'ny'),
  ('cabbage',         'cabbage', 'en'),
  ('chinese_cabbage', 'chayinizi', 'ny'),
  ('chinese_cabbage', 'chinese cabbage', 'en'),
  ('carrot',          'kaloti', 'ny'),
  ('carrot',          'carrot', 'en'),
  ('eggplant',        'mabilinganya', 'ny'),
  ('eggplant',        'eggplant', 'en'),
  ('eggplant',        'aubergine', 'en'),
  ('green_beans',     'zitheba', 'ny'),
  ('green_beans',     'green beans', 'en'),
  ('peas',            'nsawawa', 'ny'),
  ('peas',            'peas', 'en'),
  ('rape',            'lepu', 'ny'),
  ('rape',            'rape', 'en'),
  ('rape',            'rape leaves', 'en'),
  ('roselle',         'chidede', 'ny'),
  ('roselle',         'roselle', 'en'),
  ('black_jack',      'chisoso', 'ny'),
  ('black_jack',      'black jack', 'en'),
  ('mushroom',        'bowa', 'ny'),
  ('mushroom',        'mushroom', 'en'),

  -- fruits not covered in 009
  ('apple',           'apozi', 'ny'),
  ('apple',           'apple', 'en'),
  ('baobab',          'malambe', 'ny'),
  ('baobab',          'baobab', 'en'),
  ('guava',           'gwafa', 'ny'),
  ('guava',           'guava', 'en'),
  ('orange',          'lalanje', 'ny'),
  ('orange',          'malalanje', 'ny'),
  ('orange',          'orange', 'en'),
  ('lemon',           'ndimu', 'ny'),
  ('lemon',           'lemon', 'en'),
  ('pineapple',       'nanazi', 'ny'),
  ('pineapple',       'pineapple', 'en'),
  ('watermelon',      'mavwende', 'ny'),
  ('watermelon',      'mavumbe', 'ny'),
  ('watermelon',      'watermelon', 'en'),
  ('papaya',          'papaya', 'ny'),
  ('papaya',          'pawpaw', 'en'),
  ('sugarcane',       'mzimbe', 'ny'),
  ('sugarcane',       'sugarcane', 'en'),

  -- grains not covered in 009 (had maize/rice, missing millet/sorghum)
  ('finger_millet',   'mawere', 'ny'),
  ('finger_millet',   'finger millet', 'en'),
  ('finger_millet',   'millet', 'en'),
  ('sorghum',         'mapira', 'ny'),
  ('sorghum',         'sorghum', 'en'),

  -- plantain/cocoyam — root/starchy staples missing entirely from 009
  ('plantain',        'matochi', 'ny'),
  ('plantain',        'plantain', 'en'),
  ('cocoyam',         'masimbi', 'ny'),
  ('cocoyam',         'koko', 'ny'),
  ('cocoyam',         'cocoyam', 'en'),
  ('cocoyam',         'taro', 'en'),

  -- meats not covered in 009 (had chicken/beef/goat/fish)
  ('quail',           'chinziri', 'ny'),
  ('quail',           'quail', 'en'),
  ('rabbit',          'kalulu', 'ny'),
  ('rabbit',          'rabbit', 'en'),
  ('pork',            'nkhumba', 'ny'),
  ('pork',            'pork', 'en'),
  ('mutton',          'nkhosa', 'ny'),
  ('mutton',          'mutton', 'en'),
  ('mutton',          'lamb', 'en'),

  -- free-range chicken — a distinct search term Malawians actually use
  ('chicken',         'chikuda', 'ny'),

  -- french fries/chips — the actual Chichewa term, missing from 009
  -- (which only had the English "chips" alias under irish_potato)
  ('irish_potato',    'chipisi', 'ny'),

  -- more local fish species names, added to the existing 'fish' group
  -- from 009 (which only had chambo/usipa/kapenta/nsomba)
  ('fish',            'mcheni', 'ny'),
  ('fish',            'utaka', 'ny'),
  ('fish',            'matemba', 'ny'),
  ('fish',            'mlamba', 'ny'),
  ('fish',            'nkholokolo', 'ny'),

  -- insect/wild-food staples — real, commonly eaten protein sources in
  -- Malawi with no synonym coverage at all in 009
  ('termites',        'ngumbi', 'ny'),
  ('termites',        'termites', 'en'),
  ('locust',          'dzombe', 'ny'),
  ('locust',          'locust', 'en'),
  ('locust',          'locusts', 'en'),
  ('caterpillar',     'nyamanyama', 'ny'),
  ('caterpillar',     'mphalabungu', 'ny'),
  ('caterpillar',     'caterpillar', 'en'),
  ('caterpillar',     'caterpillars', 'en'),
  ('lake_flies',      'nkhungu', 'ny'),
  ('lake_flies',      'lake flies', 'en'),

  -- plain water — comes up in fluid-intake / recipe contexts
  ('water',           'madzi', 'ny'),
  ('water',           'water', 'en')
on conflict (group_key, term) do nothing;
