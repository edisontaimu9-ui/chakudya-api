-- Chakudya Nutrition Registry
-- Migration: Nutrition Care Process nutrition diagnostic terminology
-- (2006 edition: Intake NI, Clinical NC, Behavioral-Environmental NB).
--
-- Powers POST /fhir/Condition/$diagnose (a PES `problemCode` such as "NI-5.2"
-- is resolved here) and GET /fhir/CodeSystem/ncp-diagnosis. Reference data
-- only — no patient data. Source: the 2006-edition "Nutrition Diagnostic
-- Terminology" sheet supplied by the project owner; the terminology belongs
-- to the Academy of Nutrition and Dietetics, so keep this table read-only to
-- the public API and do not present it as Chakudya's own content.
--
-- Run once in the Supabase SQL editor (idempotent: re-running upserts).
-- 62 terms. `specify_required` = the sheet marks the term "(specify)";
-- `specify_options` = the sheet's tick-list for vitamin/mineral terms;
-- `use_with_caution` = the sheet's "(use with caution)" flag.

create table if not exists public.ncp_diagnosis_terms (
  code text primary key,                 -- e.g. 'NI-5.2', 'NC-3.1', 'NB-1.4'
  term text not null,                    -- e.g. 'Evident protein-energy malnutrition'
  domain text not null check (domain in ('intake','clinical','behavioral-environmental')),
  domain_prefix text not null check (domain_prefix in ('NI','NC','NB')),
  class_number text not null,            -- '1'..'5', or '51'..'55' for nutrient sub-classes
  class_name text not null,
  class_definition text,                 -- null for the 51-55 sub-classes (defined by class 5)
  parent_class_number text,              -- '5' for the 51-55 sub-classes
  specify_required boolean not null default false,
  use_with_caution boolean not null default false,
  specify_options text[],                -- tick-list for vitamin/mineral terms
  edition text not null default '2006',
  created_at timestamptz not null default now()
);

create index if not exists ncp_diagnosis_terms_domain_idx on public.ncp_diagnosis_terms (domain, class_number);

alter table public.ncp_diagnosis_terms enable row level security;
-- No anon policies: the Worker reads with its service key; nothing here is
-- exposed directly through Supabase's public REST API.

comment on table public.ncp_diagnosis_terms is
  'NCP nutrition diagnostic terminology (2006 edition, NI/NC/NB). Reference data used to validate and code PES problem statements.';

insert into public.ncp_diagnosis_terms
  (code, term, domain, domain_prefix, class_number, class_name, class_definition, parent_class_number, specify_required, use_with_caution, specify_options)
values
  ('NI-1.1', 'Hypermetabolism (Increased energy needs)', 'intake', 'NI', '1', 'Caloric Energy Balance', 'actual or estimated changes in energy (kcal)', null, false, false, null),
  ('NI-1.2', 'Increased energy expenditure', 'intake', 'NI', '1', 'Caloric Energy Balance', 'actual or estimated changes in energy (kcal)', null, false, false, null),
  ('NI-1.3', 'Hypometabolism (Decreased energy needs)', 'intake', 'NI', '1', 'Caloric Energy Balance', 'actual or estimated changes in energy (kcal)', null, false, false, null),
  ('NI-1.4', 'Inadequate energy intake', 'intake', 'NI', '1', 'Caloric Energy Balance', 'actual or estimated changes in energy (kcal)', null, false, false, null),
  ('NI-1.5', 'Excessive energy intake', 'intake', 'NI', '1', 'Caloric Energy Balance', 'actual or estimated changes in energy (kcal)', null, false, false, null),
  ('NI-2.1', 'Inadequate oral food/beverage intake', 'intake', 'NI', '2', 'Oral or Nutrition Support Intake', 'actual or estimated food and beverage intake from oral diet or nutrition support compared with patient goal', null, false, false, null),
  ('NI-2.2', 'Excessive oral food/beverage intake', 'intake', 'NI', '2', 'Oral or Nutrition Support Intake', 'actual or estimated food and beverage intake from oral diet or nutrition support compared with patient goal', null, false, false, null),
  ('NI-2.3', 'Inadequate intake from enteral/parenteral nutrition infusion', 'intake', 'NI', '2', 'Oral or Nutrition Support Intake', 'actual or estimated food and beverage intake from oral diet or nutrition support compared with patient goal', null, false, false, null),
  ('NI-2.4', 'Excessive intake from enteral/parenteral nutrition', 'intake', 'NI', '2', 'Oral or Nutrition Support Intake', 'actual or estimated food and beverage intake from oral diet or nutrition support compared with patient goal', null, false, false, null),
  ('NI-2.5', 'Inappropriate infusion of enteral/parenteral nutrition', 'intake', 'NI', '2', 'Oral or Nutrition Support Intake', 'actual or estimated food and beverage intake from oral diet or nutrition support compared with patient goal', null, false, true, null),
  ('NI-3.1', 'Inadequate fluid intake', 'intake', 'NI', '3', 'Fluid Intake', 'actual or estimated fluid intake compared with patient goal', null, false, false, null),
  ('NI-3.2', 'Excessive fluid intake', 'intake', 'NI', '3', 'Fluid Intake', 'actual or estimated fluid intake compared with patient goal', null, false, false, null),
  ('NI-4.1', 'Inadequate bioactive substance intake', 'intake', 'NI', '4', 'Bioactive Substance Intake', 'actual or observed intake of bioactive substances, including single or multiple functional food components, ingredients, dietary supplements, alcohol', null, false, false, null),
  ('NI-4.2', 'Excessive bioactive substance intake', 'intake', 'NI', '4', 'Bioactive Substance Intake', 'actual or observed intake of bioactive substances, including single or multiple functional food components, ingredients, dietary supplements, alcohol', null, false, false, null),
  ('NI-4.3', 'Excessive alcohol intake', 'intake', 'NI', '4', 'Bioactive Substance Intake', 'actual or observed intake of bioactive substances, including single or multiple functional food components, ingredients, dietary supplements, alcohol', null, false, false, null),
  ('NI-5.1', 'Increased nutrient needs', 'intake', 'NI', '5', 'Nutrient Intake', 'actual or estimated intake of specific nutrient groups or single nutrients as compared with desired levels', null, true, false, null),
  ('NI-5.2', 'Evident protein-energy malnutrition', 'intake', 'NI', '5', 'Nutrient Intake', 'actual or estimated intake of specific nutrient groups or single nutrients as compared with desired levels', null, false, false, null),
  ('NI-5.3', 'Inadequate protein-energy intake', 'intake', 'NI', '5', 'Nutrient Intake', 'actual or estimated intake of specific nutrient groups or single nutrients as compared with desired levels', null, false, false, null),
  ('NI-5.4', 'Decreased nutrient needs', 'intake', 'NI', '5', 'Nutrient Intake', 'actual or estimated intake of specific nutrient groups or single nutrients as compared with desired levels', null, true, false, null),
  ('NI-5.5', 'Imbalance of nutrients', 'intake', 'NI', '5', 'Nutrient Intake', 'actual or estimated intake of specific nutrient groups or single nutrients as compared with desired levels', null, false, false, null),
  ('NI-51.1', 'Inadequate fat intake', 'intake', 'NI', '51', 'Fat and Cholesterol', null, '5', false, false, null),
  ('NI-51.2', 'Excessive fat intake', 'intake', 'NI', '51', 'Fat and Cholesterol', null, '5', false, false, null),
  ('NI-51.3', 'Inappropriate intake of food fats', 'intake', 'NI', '51', 'Fat and Cholesterol', null, '5', true, false, null),
  ('NI-52.1', 'Inadequate protein intake', 'intake', 'NI', '52', 'Protein', null, '5', false, false, null),
  ('NI-52.2', 'Excessive protein intake', 'intake', 'NI', '52', 'Protein', null, '5', false, false, null),
  ('NI-52.3', 'Inappropriate intake of amino acids', 'intake', 'NI', '52', 'Protein', null, '5', true, false, null),
  ('NI-53.1', 'Inadequate carbohydrate intake', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', false, false, null),
  ('NI-53.2', 'Excessive carbohydrate intake', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', false, false, null),
  ('NI-53.3', 'Inappropriate intake of types of carbohydrate', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', true, false, null),
  ('NI-53.4', 'Inconsistent carbohydrate intake', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', false, false, null),
  ('NI-53.5', 'Inadequate fiber intake', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', false, false, null),
  ('NI-53.6', 'Excessive fiber intake', 'intake', 'NI', '53', 'Carbohydrate and Fiber', null, '5', false, false, null),
  ('NI-54.1', 'Inadequate vitamin intake', 'intake', 'NI', '54', 'Vitamin', null, '5', true, false, array['A','C','Thiamin','D','Riboflavin','E','Niacin','K','Folate','Other']),
  ('NI-54.2', 'Excessive vitamin intake', 'intake', 'NI', '54', 'Vitamin', null, '5', true, false, array['A','C','Thiamin','D','Riboflavin','E','Niacin','K','Folate','Other']),
  ('NI-55.1', 'Inadequate mineral intake', 'intake', 'NI', '55', 'Mineral', null, '5', true, false, array['Calcium','Iron','Potassium','Zinc','Other']),
  ('NI-55.2', 'Excessive mineral intake', 'intake', 'NI', '55', 'Mineral', null, '5', true, false, array['Calcium','Iron','Potassium','Zinc','Other']),
  ('NC-1.1', 'Swallowing difficulty', 'clinical', 'NC', '1', 'Functional', 'change in physical or mechanical functioning that interferes with or prevents desired nutritional consequences', null, false, false, null),
  ('NC-1.2', 'Chewing (masticatory) difficulty', 'clinical', 'NC', '1', 'Functional', 'change in physical or mechanical functioning that interferes with or prevents desired nutritional consequences', null, false, false, null),
  ('NC-1.3', 'Breastfeeding difficulty', 'clinical', 'NC', '1', 'Functional', 'change in physical or mechanical functioning that interferes with or prevents desired nutritional consequences', null, false, false, null),
  ('NC-1.4', 'Altered GI function', 'clinical', 'NC', '1', 'Functional', 'change in physical or mechanical functioning that interferes with or prevents desired nutritional consequences', null, false, false, null),
  ('NC-2.1', 'Impaired nutrient utilization', 'clinical', 'NC', '2', 'Biochemical', 'change in capacity to metabolize nutrients as a result of medications, surgery, or as indicated by altered lab values', null, false, false, null),
  ('NC-2.2', 'Altered nutrition-related laboratory values', 'clinical', 'NC', '2', 'Biochemical', 'change in capacity to metabolize nutrients as a result of medications, surgery, or as indicated by altered lab values', null, true, false, null),
  ('NC-2.3', 'Food-medication interaction', 'clinical', 'NC', '2', 'Biochemical', 'change in capacity to metabolize nutrients as a result of medications, surgery, or as indicated by altered lab values', null, false, false, null),
  ('NC-3.1', 'Underweight', 'clinical', 'NC', '3', 'Weight', 'chronic weight or changed weight status when compared with usual or desired body weight', null, false, false, null),
  ('NC-3.2', 'Involuntary weight loss', 'clinical', 'NC', '3', 'Weight', 'chronic weight or changed weight status when compared with usual or desired body weight', null, false, false, null),
  ('NC-3.3', 'Overweight/obesity', 'clinical', 'NC', '3', 'Weight', 'chronic weight or changed weight status when compared with usual or desired body weight', null, false, false, null),
  ('NC-3.4', 'Involuntary weight gain', 'clinical', 'NC', '3', 'Weight', 'chronic weight or changed weight status when compared with usual or desired body weight', null, false, false, null),
  ('NB-1.1', 'Food, nutrition, and nutrition-related knowledge deficit', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-1.2', 'Harmful beliefs/attitudes about food or nutrition-related topics', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, true, null),
  ('NB-1.3', 'Not ready for diet/lifestyle change', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-1.4', 'Self-monitoring deficit', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-1.5', 'Disordered eating pattern', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-1.6', 'Limited adherence to nutrition-related recommendations', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-1.7', 'Undesirable food choices', 'behavioral-environmental', 'NB', '1', 'Knowledge and Beliefs', 'actual knowledge and beliefs as reported or documented', null, false, false, null),
  ('NB-2.1', 'Physical inactivity', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-2.2', 'Excessive exercise', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-2.3', 'Inability or lack of desire to manage self-care', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-2.4', 'Impaired ability to prepare foods/meals', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-2.5', 'Poor nutrition quality of life', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-2.6', 'Self-feeding difficulty', 'behavioral-environmental', 'NB', '2', 'Physical Activity and Function', 'actual physical activity, self-care, and quality of life problems as reported, observed, or documented', null, false, false, null),
  ('NB-3.1', 'Intake of unsafe food', 'behavioral-environmental', 'NB', '3', 'Food Safety and Access', 'actual problems with food access or food safety', null, false, false, null),
  ('NB-3.2', 'Limited access to food', 'behavioral-environmental', 'NB', '3', 'Food Safety and Access', 'actual problems with food access or food safety', null, false, false, null)
on conflict (code) do update set
  term = excluded.term, domain = excluded.domain, domain_prefix = excluded.domain_prefix,
  class_number = excluded.class_number, class_name = excluded.class_name,
  class_definition = excluded.class_definition, parent_class_number = excluded.parent_class_number,
  specify_required = excluded.specify_required, use_with_caution = excluded.use_with_caution,
  specify_options = excluded.specify_options;
