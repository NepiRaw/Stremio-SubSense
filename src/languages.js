/**
 * Unified Language Module
 * Single source of truth for all language codes across SubSense
 * 
 * Supports:
 * - ISO 639-1 (2-letter): en, es, fr, de, etc.
 * - ISO 639-2/B (3-letter bibliographic): eng, spa, fre, ger, etc. (Stremio standard)
 * - ISO 639-2/T (3-letter terminology): eng, spa, fra, deu, etc.
 * - Provider-specific codes: YIFY (full names), TVsubtitles (short codes), BetaSeries (vf/vo)
 * - Display names in English
 */

const i18nLanguages = require('@cospired/i18n-iso-languages');

// Register English locale for language names
i18nLanguages.registerLocale(require('@cospired/i18n-iso-languages/langs/en.json'));

/**
 * Master Language Table
 * All supported languages with their various code formats
 * 
 * Structure:
 * - alpha2: ISO 639-1 (2-letter) code
 * - alpha3B: ISO 639-2/B (3-letter bibliographic) code - Stremio standard
 * - alpha3T: ISO 639-2/T (3-letter terminology) code - same as B for most
 * - name: English display name
 * - nativeName: Name in the language itself (optional)
 * - providerCodes: Provider-specific code mappings
 *   - yify: Full language name as used by YIFY/YTS
 *   - tvsubtitles: Short code as used by TVsubtitles
 *   - betaseries: VF/VO code (only for French/English)
 */
const LANGUAGE_TABLE = [
    { alpha2: 'ab', alpha3B: 'abk', alpha3T: 'abk', name: 'Abkhaz', nativeName: 'аҧсуа' },
    { alpha2: 'aa', alpha3B: 'aar', alpha3T: 'aar', name: 'Afar', nativeName: 'Afaraf' },
    { alpha2: 'af', alpha3B: 'afr', alpha3T: 'afr', name: 'Afrikaans', nativeName: 'Afrikaans' },
    { alpha2: 'ak', alpha3B: 'aka', alpha3T: 'aka', name: 'Akan', nativeName: 'Akan' },
    { alpha2: 'sq', alpha3B: 'alb', alpha3T: 'sqi', name: 'Albanian', nativeName: 'Shqip', providerCodes: { yify: 'albanian' } },
    { alpha2: 'am', alpha3B: 'amh', alpha3T: 'amh', name: 'Amharic', nativeName: 'አማርኛ' },
    { alpha2: 'ar', alpha3B: 'ara', alpha3T: 'ara', name: 'Arabic', nativeName: 'العربية', providerCodes: { yify: 'arabic', tvsubtitles: 'ar' } },
    { alpha2: 'an', alpha3B: 'arg', alpha3T: 'arg', name: 'Aragonese', nativeName: 'Aragonés' },
    { alpha2: 'hy', alpha3B: 'arm', alpha3T: 'hye', name: 'Armenian', nativeName: 'Հայdelays' },
    { alpha2: 'as', alpha3B: 'asm', alpha3T: 'asm', name: 'Assamese', nativeName: 'অসমীয়া' },
    { alpha2: 'av', alpha3B: 'ava', alpha3T: 'ava', name: 'Avaric', nativeName: 'авар мацӀ' },
    { alpha2: 'ae', alpha3B: 'ave', alpha3T: 'ave', name: 'Avestan', nativeName: 'avesta' },
    { alpha2: 'ay', alpha3B: 'aym', alpha3T: 'aym', name: 'Aymara', nativeName: 'aymar aru' },
    { alpha2: 'az', alpha3B: 'aze', alpha3T: 'aze', name: 'Azerbaijani', nativeName: 'azərbaycan dili' },
    { alpha2: 'bm', alpha3B: 'bam', alpha3T: 'bam', name: 'Bambara', nativeName: 'bamanankan' },
    { alpha2: 'ba', alpha3B: 'bak', alpha3T: 'bak', name: 'Bashkir', nativeName: 'башҡорт теле' },
    { alpha2: 'eu', alpha3B: 'baq', alpha3T: 'eus', name: 'Basque', nativeName: 'euskara' },
    { alpha2: 'be', alpha3B: 'bel', alpha3T: 'bel', name: 'Belarusian', nativeName: 'беларуская' },
    { alpha2: 'bn', alpha3B: 'ben', alpha3T: 'ben', name: 'Bengali', nativeName: 'বাংলা', providerCodes: { yify: 'bengali' } },
    { alpha2: 'bi', alpha3B: 'bis', alpha3T: 'bis', name: 'Bislama', nativeName: 'Bislama' },
    { alpha2: 'bs', alpha3B: 'bos', alpha3T: 'bos', name: 'Bosnian', nativeName: 'bosanski jezik' },
    { alpha2: 'br', alpha3B: 'bre', alpha3T: 'bre', name: 'Breton', nativeName: 'brezhoneg' },
    { alpha2: 'bg', alpha3B: 'bul', alpha3T: 'bul', name: 'Bulgarian', nativeName: 'български', providerCodes: { yify: 'bulgarian', tvsubtitles: 'bg' } },
    { alpha2: 'my', alpha3B: 'bur', alpha3T: 'mya', name: 'Burmese', nativeName: 'ဗမာစာ' },
    { alpha2: 'ca', alpha3B: 'cat', alpha3T: 'cat', name: 'Catalan', nativeName: 'Català' },
    { alpha2: 'ch', alpha3B: 'cha', alpha3T: 'cha', name: 'Chamorro', nativeName: 'Chamoru' },
    { alpha2: 'ce', alpha3B: 'che', alpha3T: 'che', name: 'Chechen', nativeName: 'нохчийн мотт' },
    { alpha2: 'ny', alpha3B: 'nya', alpha3T: 'nya', name: 'Chichewa', nativeName: 'chiCheŵa' },
    { alpha2: 'zh', alpha3B: 'chi', alpha3T: 'zho', name: 'Chinese', nativeName: '中文', providerCodes: { yify: 'chinese', tvsubtitles: 'zh' } },
    { alpha2: 'cv', alpha3B: 'chv', alpha3T: 'chv', name: 'Chuvash', nativeName: 'чӑваш чӗлхи' },
    { alpha2: 'kw', alpha3B: 'cor', alpha3T: 'cor', name: 'Cornish', nativeName: 'Kernewek' },
    { alpha2: 'co', alpha3B: 'cos', alpha3T: 'cos', name: 'Corsican', nativeName: 'corsu' },
    { alpha2: 'cr', alpha3B: 'cre', alpha3T: 'cre', name: 'Cree', nativeName: 'ᓀᐦᐃᔭᐍᐏᐣ' },
    { alpha2: 'hr', alpha3B: 'hrv', alpha3T: 'hrv', name: 'Croatian', nativeName: 'hrvatski', providerCodes: { yify: 'croatian', tvsubtitles: 'hr' } },
    { alpha2: 'cs', alpha3B: 'cze', alpha3T: 'ces', name: 'Czech', nativeName: 'čeština', providerCodes: { yify: 'czech', tvsubtitles: 'cs' } },
    { alpha2: 'da', alpha3B: 'dan', alpha3T: 'dan', name: 'Danish', nativeName: 'dansk', providerCodes: { yify: 'danish', tvsubtitles: 'da' } },
    { alpha2: 'dv', alpha3B: 'div', alpha3T: 'div', name: 'Divehi', nativeName: 'ދިވެހި' },
    { alpha2: 'nl', alpha3B: 'dut', alpha3T: 'nld', name: 'Dutch', nativeName: 'Nederlands', providerCodes: { yify: 'dutch', tvsubtitles: 'nl' } },
    { alpha2: 'dz', alpha3B: 'dzo', alpha3T: 'dzo', name: 'Dzongkha', nativeName: 'རྫོང་ཁ' },
    { alpha2: 'en', alpha3B: 'eng', alpha3T: 'eng', name: 'English', nativeName: 'English', providerCodes: { yify: 'english', tvsubtitles: 'en', betaseries: 'vo' } },
    { alpha2: 'eo', alpha3B: 'epo', alpha3T: 'epo', name: 'Esperanto', nativeName: 'Esperanto' },
    { alpha2: 'et', alpha3B: 'est', alpha3T: 'est', name: 'Estonian', nativeName: 'eesti' },
    { alpha2: 'ee', alpha3B: 'ewe', alpha3T: 'ewe', name: 'Ewe', nativeName: 'Eʋegbe' },
    { alpha2: 'fo', alpha3B: 'fao', alpha3T: 'fao', name: 'Faroese', nativeName: 'føroyskt' },
    { alpha2: 'fj', alpha3B: 'fij', alpha3T: 'fij', name: 'Fijian', nativeName: 'vosa Vakaviti' },
    { alpha2: 'fi', alpha3B: 'fin', alpha3T: 'fin', name: 'Finnish', nativeName: 'suomi', providerCodes: { yify: 'finnish', tvsubtitles: 'fi' } },
    { alpha2: 'fr', alpha3B: 'fre', alpha3T: 'fra', name: 'French', nativeName: 'Français', providerCodes: { yify: 'french', tvsubtitles: 'fr', betaseries: 'vf' } },
    { alpha2: 'ff', alpha3B: 'ful', alpha3T: 'ful', name: 'Fula', nativeName: 'Fulfulde' },
    { alpha2: 'gl', alpha3B: 'glg', alpha3T: 'glg', name: 'Galician', nativeName: 'Galego' },
    { alpha2: 'lg', alpha3B: 'lug', alpha3T: 'lug', name: 'Ganda', nativeName: 'Luganda' },
    { alpha2: 'ka', alpha3B: 'geo', alpha3T: 'kat', name: 'Georgian', nativeName: 'ქართული' },
    { alpha2: 'de', alpha3B: 'ger', alpha3T: 'deu', name: 'German', nativeName: 'Deutsch', providerCodes: { yify: 'german', tvsubtitles: 'de' } },
    { alpha2: 'el', alpha3B: 'gre', alpha3T: 'ell', name: 'Greek', nativeName: 'Ελληνικά', providerCodes: { yify: 'greek', tvsubtitles: 'gr' } },
    { alpha2: 'gn', alpha3B: 'grn', alpha3T: 'grn', name: 'Guaraní', nativeName: 'Avañe\'ẽ' },
    { alpha2: 'gu', alpha3B: 'guj', alpha3T: 'guj', name: 'Gujarati', nativeName: 'ગુજરાતી' },
    { alpha2: 'ht', alpha3B: 'hat', alpha3T: 'hat', name: 'Haitian', nativeName: 'Kreyòl ayisyen' },
    { alpha2: 'ha', alpha3B: 'hau', alpha3T: 'hau', name: 'Hausa', nativeName: 'Hausa' },
    { alpha2: 'he', alpha3B: 'heb', alpha3T: 'heb', name: 'Hebrew', nativeName: 'עברית', providerCodes: { yify: 'hebrew', tvsubtitles: 'he' } },
    { alpha2: 'hz', alpha3B: 'her', alpha3T: 'her', name: 'Herero', nativeName: 'Otjiherero' },
    { alpha2: 'hi', alpha3B: 'hin', alpha3T: 'hin', name: 'Hindi', nativeName: 'हिन्दी', providerCodes: { yify: 'hindi', tvsubtitles: 'hi' } },
    { alpha2: 'ho', alpha3B: 'hmo', alpha3T: 'hmo', name: 'Hiri Motu', nativeName: 'Hiri Motu' },
    { alpha2: 'hu', alpha3B: 'hun', alpha3T: 'hun', name: 'Hungarian', nativeName: 'Magyar', providerCodes: { yify: 'hungarian', tvsubtitles: 'hu' } },
    { alpha2: 'is', alpha3B: 'ice', alpha3T: 'isl', name: 'Icelandic', nativeName: 'Íslenska', providerCodes: { yify: 'icelandic' } },
    { alpha2: 'io', alpha3B: 'ido', alpha3T: 'ido', name: 'Ido', nativeName: 'Ido' },
    { alpha2: 'ig', alpha3B: 'ibo', alpha3T: 'ibo', name: 'Igbo', nativeName: 'Asụsụ Igbo' },
    { alpha2: 'id', alpha3B: 'ind', alpha3T: 'ind', name: 'Indonesian', nativeName: 'Bahasa Indonesia', providerCodes: { yify: 'indonesian', tvsubtitles: 'id' } },
    { alpha2: 'ia', alpha3B: 'ina', alpha3T: 'ina', name: 'Interlingua', nativeName: 'Interlingua' },
    { alpha2: 'ie', alpha3B: 'ile', alpha3T: 'ile', name: 'Interlingue', nativeName: 'Interlingue' },
    { alpha2: 'iu', alpha3B: 'iku', alpha3T: 'iku', name: 'Inuktitut', nativeName: 'ᐃᓄᒃᑎᑐᑦ' },
    { alpha2: 'ik', alpha3B: 'ipk', alpha3T: 'ipk', name: 'Inupiaq', nativeName: 'Iñupiaq' },
    { alpha2: 'ga', alpha3B: 'gle', alpha3T: 'gle', name: 'Irish', nativeName: 'Gaeilge' },
    { alpha2: 'it', alpha3B: 'ita', alpha3T: 'ita', name: 'Italian', nativeName: 'Italiano', providerCodes: { yify: 'italian', tvsubtitles: 'it' } },
    { alpha2: 'ja', alpha3B: 'jpn', alpha3T: 'jpn', name: 'Japanese', nativeName: '日本語', providerCodes: { yify: 'japanese', tvsubtitles: 'ja' } },
    { alpha2: 'jv', alpha3B: 'jav', alpha3T: 'jav', name: 'Javanese', nativeName: 'basa Jawa' },
    { alpha2: 'kl', alpha3B: 'kal', alpha3T: 'kal', name: 'Kalaallisut', nativeName: 'kalaallisut' },
    { alpha2: 'kn', alpha3B: 'kan', alpha3T: 'kan', name: 'Kannada', nativeName: 'ಕನ್ನಡ' },
    { alpha2: 'kr', alpha3B: 'kau', alpha3T: 'kau', name: 'Kanuri', nativeName: 'Kanuri' },
    { alpha2: 'ks', alpha3B: 'kas', alpha3T: 'kas', name: 'Kashmiri', nativeName: 'कश्मीरी' },
    { alpha2: 'kk', alpha3B: 'kaz', alpha3T: 'kaz', name: 'Kazakh', nativeName: 'қазақ тілі' },
    { alpha2: 'km', alpha3B: 'khm', alpha3T: 'khm', name: 'Khmer', nativeName: 'ភាសាខ្មែរ' },
    { alpha2: 'ki', alpha3B: 'kik', alpha3T: 'kik', name: 'Kikuyu', nativeName: 'Gĩkũyũ' },
    { alpha2: 'rw', alpha3B: 'kin', alpha3T: 'kin', name: 'Kinyarwanda', nativeName: 'Ikinyarwanda' },
    { alpha2: 'rn', alpha3B: 'run', alpha3T: 'run', name: 'Kirundi', nativeName: 'Ikirundi' },
    { alpha2: 'kv', alpha3B: 'kom', alpha3T: 'kom', name: 'Komi', nativeName: 'коми кыв' },
    { alpha2: 'kg', alpha3B: 'kon', alpha3T: 'kon', name: 'Kongo', nativeName: 'KiKongo' },
    { alpha2: 'ko', alpha3B: 'kor', alpha3T: 'kor', name: 'Korean', nativeName: '한국어', providerCodes: { yify: 'korean', tvsubtitles: 'ko' } },
    { alpha2: 'ku', alpha3B: 'kur', alpha3T: 'kur', name: 'Kurdish', nativeName: 'Kurdî' },
    { alpha2: 'kj', alpha3B: 'kua', alpha3T: 'kua', name: 'Kwanyama', nativeName: 'Kuanyama' },
    { alpha2: 'ky', alpha3B: 'kir', alpha3T: 'kir', name: 'Kyrgyz', nativeName: 'Кыргыз тили' },
    { alpha2: 'lo', alpha3B: 'lao', alpha3T: 'lao', name: 'Lao', nativeName: 'ພາສາລາວ' },
    { alpha2: 'la', alpha3B: 'lat', alpha3T: 'lat', name: 'Latin', nativeName: 'latine' },
    { alpha2: 'lv', alpha3B: 'lav', alpha3T: 'lav', name: 'Latvian', nativeName: 'latviešu valoda' },
    { alpha2: 'li', alpha3B: 'lim', alpha3T: 'lim', name: 'Limburgish', nativeName: 'Limburgs' },
    { alpha2: 'ln', alpha3B: 'lin', alpha3T: 'lin', name: 'Lingala', nativeName: 'Lingála' },
    { alpha2: 'lt', alpha3B: 'lit', alpha3T: 'lit', name: 'Lithuanian', nativeName: 'lietuvių kalba' },
    { alpha2: 'lu', alpha3B: 'lub', alpha3T: 'lub', name: 'Luba-Katanga', nativeName: 'Tshiluba' },
    { alpha2: 'lb', alpha3B: 'ltz', alpha3T: 'ltz', name: 'Luxembourgish', nativeName: 'Lëtzebuergesch' },
    { alpha2: 'mk', alpha3B: 'mac', alpha3T: 'mkd', name: 'Macedonian', nativeName: 'македонски јазик' },
    { alpha2: 'mg', alpha3B: 'mlg', alpha3T: 'mlg', name: 'Malagasy', nativeName: 'Malagasy fiteny' },
    { alpha2: 'ms', alpha3B: 'may', alpha3T: 'msa', name: 'Malay', nativeName: 'bahasa Melayu', providerCodes: { yify: 'malay' } },
    { alpha2: 'ml', alpha3B: 'mal', alpha3T: 'mal', name: 'Malayalam', nativeName: 'മലയാളം' },
    { alpha2: 'mt', alpha3B: 'mlt', alpha3T: 'mlt', name: 'Maltese', nativeName: 'Malti' },
    { alpha2: 'gv', alpha3B: 'glv', alpha3T: 'glv', name: 'Manx', nativeName: 'Gaelg' },
    { alpha2: 'mi', alpha3B: 'mao', alpha3T: 'mri', name: 'Maori', nativeName: 'te reo Māori' },
    { alpha2: 'mr', alpha3B: 'mar', alpha3T: 'mar', name: 'Marathi', nativeName: 'मराठी' },
    { alpha2: 'mh', alpha3B: 'mah', alpha3T: 'mah', name: 'Marshallese', nativeName: 'Kajin M̧ajeļ' },
    { alpha2: 'mn', alpha3B: 'mon', alpha3T: 'mon', name: 'Mongolian', nativeName: 'монгол' },
    { alpha2: 'na', alpha3B: 'nau', alpha3T: 'nau', name: 'Nauru', nativeName: 'Ekakairũ Naoero' },
    { alpha2: 'nv', alpha3B: 'nav', alpha3T: 'nav', name: 'Navajo', nativeName: 'Diné bizaad' },
    { alpha2: 'ng', alpha3B: 'ndo', alpha3T: 'ndo', name: 'Ndonga', nativeName: 'Owambo' },
    { alpha2: 'ne', alpha3B: 'nep', alpha3T: 'nep', name: 'Nepali', nativeName: 'नेपाली' },
    { alpha2: 'nd', alpha3B: 'nde', alpha3T: 'nde', name: 'Northern Ndebele', nativeName: 'isiNdebele' },
    { alpha2: 'se', alpha3B: 'sme', alpha3T: 'sme', name: 'Northern Sami', nativeName: 'Davvisámegiella' },
    { alpha2: 'no', alpha3B: 'nor', alpha3T: 'nor', name: 'Norwegian', nativeName: 'Norsk', providerCodes: { yify: 'norwegian', tvsubtitles: 'no' } },
    { alpha2: 'nb', alpha3B: 'nob', alpha3T: 'nob', name: 'Norwegian Bokmål', nativeName: 'Norsk bokmål' },
    { alpha2: 'nn', alpha3B: 'nno', alpha3T: 'nno', name: 'Norwegian Nynorsk', nativeName: 'Norsk nynorsk' },
    { alpha2: 'ii', alpha3B: 'iii', alpha3T: 'iii', name: 'Nuosu', nativeName: 'ꆈꌠ꒿ Nuosuhxop' },
    { alpha2: 'oc', alpha3B: 'oci', alpha3T: 'oci', name: 'Occitan', nativeName: 'Occitan' },
    { alpha2: 'oj', alpha3B: 'oji', alpha3T: 'oji', name: 'Ojibwe', nativeName: 'ᐊᓂᔑᓈᐯᒧᐎᓐ' },
    { alpha2: 'cu', alpha3B: 'chu', alpha3T: 'chu', name: 'Old Church Slavonic', nativeName: 'ѩзыкъ словѣньскъ' },
    { alpha2: 'or', alpha3B: 'ori', alpha3T: 'ori', name: 'Oriya', nativeName: 'ଓଡ଼ିଆ' },
    { alpha2: 'om', alpha3B: 'orm', alpha3T: 'orm', name: 'Oromo', nativeName: 'Afaan Oromoo' },
    { alpha2: 'os', alpha3B: 'oss', alpha3T: 'oss', name: 'Ossetian', nativeName: 'ирон æвзаг' },
    { alpha2: 'pi', alpha3B: 'pli', alpha3T: 'pli', name: 'Pali', nativeName: 'पाऴि' },
    { alpha2: 'pa', alpha3B: 'pan', alpha3T: 'pan', name: 'Panjabi', nativeName: 'ਪੰਜਾਬੀ' },
    { alpha2: 'ps', alpha3B: 'pus', alpha3T: 'pus', name: 'Pashto', nativeName: 'پښتو' },
    { alpha2: 'fa', alpha3B: 'per', alpha3T: 'fas', name: 'Persian', nativeName: 'فارسی', providerCodes: { yify: 'persian', yifyAlt: 'farsi', tvsubtitles: 'fa' } },
    { alpha2: 'pl', alpha3B: 'pol', alpha3T: 'pol', name: 'Polish', nativeName: 'polski', providerCodes: { yify: 'polish', tvsubtitles: 'pl' } },
    { alpha2: 'pt', alpha3B: 'por', alpha3T: 'por', name: 'Portuguese', nativeName: 'Português', providerCodes: { yify: 'portuguese', tvsubtitles: 'pt' } },
    { alpha2: 'pt-BR', alpha3B: 'por', alpha3T: 'por', name: 'Portuguese (Brazil)', nativeName: 'Português (Brasil)', providerCodes: { yify: 'brazilian', yifyAlt: 'brazilian-portuguese', tvsubtitles: 'br' } },
    { alpha2: 'qu', alpha3B: 'que', alpha3T: 'que', name: 'Quechua', nativeName: 'Runa Simi' },
    { alpha2: 'ro', alpha3B: 'rum', alpha3T: 'ron', name: 'Romanian', nativeName: 'română', providerCodes: { yify: 'romanian', tvsubtitles: 'ro' } },
    { alpha2: 'rm', alpha3B: 'roh', alpha3T: 'roh', name: 'Romansh', nativeName: 'rumantsch grischun' },
    { alpha2: 'ru', alpha3B: 'rus', alpha3T: 'rus', name: 'Russian', nativeName: 'Русский', providerCodes: { yify: 'russian', tvsubtitles: 'ru' } },
    { alpha2: 'sm', alpha3B: 'smo', alpha3T: 'smo', name: 'Samoan', nativeName: 'gagana Samoa' },
    { alpha2: 'sg', alpha3B: 'sag', alpha3T: 'sag', name: 'Sango', nativeName: 'yângâ tî sängö' },
    { alpha2: 'sa', alpha3B: 'san', alpha3T: 'san', name: 'Sanskrit', nativeName: 'संस्कृतम्' },
    { alpha2: 'sc', alpha3B: 'srd', alpha3T: 'srd', name: 'Sardinian', nativeName: 'sardu' },
    { alpha2: 'gd', alpha3B: 'gla', alpha3T: 'gla', name: 'Scottish Gaelic', nativeName: 'Gàidhlig' },
    { alpha2: 'sr', alpha3B: 'srp', alpha3T: 'srp', name: 'Serbian', nativeName: 'српски језик', providerCodes: { yify: 'serbian', tvsubtitles: 'sr' } },
    { alpha2: 'sn', alpha3B: 'sna', alpha3T: 'sna', name: 'Shona', nativeName: 'chiShona' },
    { alpha2: 'sd', alpha3B: 'snd', alpha3T: 'snd', name: 'Sindhi', nativeName: 'सिन्धी' },
    { alpha2: 'si', alpha3B: 'sin', alpha3T: 'sin', name: 'Sinhala', nativeName: 'සිංහල' },
    { alpha2: 'sk', alpha3B: 'slo', alpha3T: 'slk', name: 'Slovak', nativeName: 'slovenčina' },
    { alpha2: 'sl', alpha3B: 'slv', alpha3T: 'slv', name: 'Slovenian', nativeName: 'slovenščina', providerCodes: { yify: 'slovenian', tvsubtitles: 'sl' } },
    { alpha2: 'so', alpha3B: 'som', alpha3T: 'som', name: 'Somali', nativeName: 'Soomaaliga' },
    { alpha2: 'nr', alpha3B: 'nbl', alpha3T: 'nbl', name: 'Southern Ndebele', nativeName: 'isiNdebele' },
    { alpha2: 'st', alpha3B: 'sot', alpha3T: 'sot', name: 'Southern Sotho', nativeName: 'Sesotho' },
    { alpha2: 'es', alpha3B: 'spa', alpha3T: 'spa', name: 'Spanish', nativeName: 'Español', providerCodes: { yify: 'spanish', tvsubtitles: 'es' } },
    { alpha2: 'su', alpha3B: 'sun', alpha3T: 'sun', name: 'Sundanese', nativeName: 'Basa Sunda' },
    { alpha2: 'sw', alpha3B: 'swa', alpha3T: 'swa', name: 'Swahili', nativeName: 'Kiswahili' },
    { alpha2: 'ss', alpha3B: 'ssw', alpha3T: 'ssw', name: 'Swati', nativeName: 'SiSwati' },
    { alpha2: 'sv', alpha3B: 'swe', alpha3T: 'swe', name: 'Swedish', nativeName: 'svenska', providerCodes: { yify: 'swedish', tvsubtitles: 'sv' } },
    { alpha2: 'tl', alpha3B: 'tgl', alpha3T: 'tgl', name: 'Tagalog', nativeName: 'Wikang Tagalog' },
    { alpha2: 'ty', alpha3B: 'tah', alpha3T: 'tah', name: 'Tahitian', nativeName: 'Reo Tahiti' },
    { alpha2: 'tg', alpha3B: 'tgk', alpha3T: 'tgk', name: 'Tajik', nativeName: 'тоҷикӣ' },
    { alpha2: 'ta', alpha3B: 'tam', alpha3T: 'tam', name: 'Tamil', nativeName: 'தமிழ்' },
    { alpha2: 'tt', alpha3B: 'tat', alpha3T: 'tat', name: 'Tatar', nativeName: 'татар теле' },
    { alpha2: 'te', alpha3B: 'tel', alpha3T: 'tel', name: 'Telugu', nativeName: 'తెలుగు' },
    { alpha2: 'th', alpha3B: 'tha', alpha3T: 'tha', name: 'Thai', nativeName: 'ไทย', providerCodes: { yify: 'thai', tvsubtitles: 'th' } },
    { alpha2: 'bo', alpha3B: 'tib', alpha3T: 'bod', name: 'Tibetan', nativeName: 'བོད་ཡིག' },
    { alpha2: 'ti', alpha3B: 'tir', alpha3T: 'tir', name: 'Tigrinya', nativeName: 'ትግርኛ' },
    { alpha2: 'to', alpha3B: 'ton', alpha3T: 'ton', name: 'Tonga', nativeName: 'faka Tonga' },
    { alpha2: 'ts', alpha3B: 'tso', alpha3T: 'tso', name: 'Tsonga', nativeName: 'Xitsonga' },
    { alpha2: 'tn', alpha3B: 'tsn', alpha3T: 'tsn', name: 'Tswana', nativeName: 'Setswana' },
    { alpha2: 'tr', alpha3B: 'tur', alpha3T: 'tur', name: 'Turkish', nativeName: 'Türkçe', providerCodes: { yify: 'turkish', tvsubtitles: 'tr' } },
    { alpha2: 'tk', alpha3B: 'tuk', alpha3T: 'tuk', name: 'Turkmen', nativeName: 'Türkmen' },
    { alpha2: 'tw', alpha3B: 'twi', alpha3T: 'twi', name: 'Twi', nativeName: 'Twi' },
    { alpha2: 'uk', alpha3B: 'ukr', alpha3T: 'ukr', name: 'Ukrainian', nativeName: 'українська', providerCodes: { yify: 'ukrainian', tvsubtitles: 'ua' } },
    { alpha2: 'ur', alpha3B: 'urd', alpha3T: 'urd', name: 'Urdu', nativeName: 'اردو' },
    { alpha2: 'ug', alpha3B: 'uig', alpha3T: 'uig', name: 'Uyghur', nativeName: 'Uyƣurqə' },
    { alpha2: 'uz', alpha3B: 'uzb', alpha3T: 'uzb', name: 'Uzbek', nativeName: 'Oʻzbek' },
    { alpha2: 've', alpha3B: 'ven', alpha3T: 'ven', name: 'Venda', nativeName: 'Tshivenḓa' },
    { alpha2: 'vi', alpha3B: 'vie', alpha3T: 'vie', name: 'Vietnamese', nativeName: 'Tiếng Việt', providerCodes: { yify: 'vietnamese', tvsubtitles: 'vi' } },
    { alpha2: 'vo', alpha3B: 'vol', alpha3T: 'vol', name: 'Volapük', nativeName: 'Volapük' },
    { alpha2: 'wa', alpha3B: 'wln', alpha3T: 'wln', name: 'Walloon', nativeName: 'Walon' },
    { alpha2: 'cy', alpha3B: 'wel', alpha3T: 'cym', name: 'Welsh', nativeName: 'Cymraeg' },
    { alpha2: 'fy', alpha3B: 'fry', alpha3T: 'fry', name: 'Western Frisian', nativeName: 'Frysk' },
    { alpha2: 'wo', alpha3B: 'wol', alpha3T: 'wol', name: 'Wolof', nativeName: 'Wollof' },
    { alpha2: 'xh', alpha3B: 'xho', alpha3T: 'xho', name: 'Xhosa', nativeName: 'isiXhosa' },
    { alpha2: 'yi', alpha3B: 'yid', alpha3T: 'yid', name: 'Yiddish', nativeName: 'ייִדיש' },
    { alpha2: 'yo', alpha3B: 'yor', alpha3T: 'yor', name: 'Yoruba', nativeName: 'Yorùbá' },
    { alpha2: 'za', alpha3B: 'zha', alpha3T: 'zha', name: 'Zhuang', nativeName: 'Saɯ cueŋƅ' },
    { alpha2: 'zu', alpha3B: 'zul', alpha3T: 'zul', name: 'Zulu', nativeName: 'isiZulu' }
];

// Build lookup indices for fast access
const _indexByAlpha2 = new Map();
const _indexByAlpha3B = new Map();
const _indexByAlpha3T = new Map();
const _indexByName = new Map();
const _indexByYify = new Map();
const _indexByTvsubtitles = new Map();
const _indexByBetaseries = new Map();
const _indexBySubsource = new Map();

LANGUAGE_TABLE.forEach((lang, idx) => {
    _indexByAlpha2.set(lang.alpha2.toLowerCase(), idx);
    _indexByAlpha3B.set(lang.alpha3B.toLowerCase(), idx);
    if (lang.alpha3T !== lang.alpha3B) {
        _indexByAlpha3T.set(lang.alpha3T.toLowerCase(), idx);
    }
    _indexByName.set(lang.name.toLowerCase(), idx);
    
    if (lang.providerCodes) {
        if (lang.providerCodes.yify) {
            _indexByYify.set(lang.providerCodes.yify.toLowerCase(), idx);
        }
        if (lang.providerCodes.yifyAlt) {
            _indexByYify.set(lang.providerCodes.yifyAlt.toLowerCase(), idx);
        }
        if (lang.providerCodes.tvsubtitles) {
            _indexByTvsubtitles.set(lang.providerCodes.tvsubtitles.toLowerCase(), idx);
        }
        if (lang.providerCodes.betaseries) {
            _indexByBetaseries.set(lang.providerCodes.betaseries.toLowerCase(), idx);
        }
        if (lang.providerCodes.subsource) {
            _indexBySubsource.set(lang.providerCodes.subsource.toLowerCase(), idx);
        }
    }
});

// SubSource uses full lowercase language names - map from alpha2 to subsource code
// This allows lookup even when providerCodes.subsource isn't explicitly set
const SUBSOURCE_LANGUAGE_MAP = {
    'en': 'english', 'fr': 'french', 'es': 'spanish', 'de': 'german',
    'pt': 'portuguese', 'ar': 'arabic', 'ja': 'japanese', 'ko': 'korean',
    'zh': 'chinese', 'it': 'italian', 'nl': 'dutch', 'ru': 'russian',
    'pl': 'polish', 'tr': 'turkish', 'sv': 'swedish', 'no': 'norwegian',
    'da': 'danish', 'fi': 'finnish', 'el': 'greek', 'he': 'hebrew',
    'hu': 'hungarian', 'cs': 'czech', 'ro': 'romanian', 'th': 'thai',
    'vi': 'vietnamese', 'id': 'indonesian', 'ms': 'malay', 'hi': 'hindi',
    'bn': 'bengali', 'ta': 'tamil', 'te': 'telugu', 'fa': 'farsi_persian',
    'uk': 'ukrainian', 'bg': 'bulgarian', 'hr': 'croatian', 'sr': 'serbian',
    'sk': 'slovak', 'sl': 'slovenian', 'is': 'icelandic', 'et': 'estonian',
    'lv': 'latvian', 'lt': 'lithuanian', 'ka': 'georgian', 'mk': 'macedonian',
    'bs': 'bosnian', 'sq': 'albanian', 'ca': 'catalan', 'eu': 'basque',
    'gl': 'galician', 'cy': 'welsh', 'sw': 'swahili', 'tl': 'tagalog',
    'ml': 'malayalam', 'kn': 'kannada', 'mr': 'marathi', 'gu': 'gujarati',
    'pa': 'punjabi', 'ur': 'urdu', 'ne': 'nepali', 'si': 'sinhala',
    'km': 'khmer', 'lo': 'lao', 'my': 'burmese', 'mn': 'mongolian'
};

// Regional variants for SubSource
const SUBSOURCE_REGIONAL_MAP = {
    'pt-br': 'brazilian_portuguese',
    'pt-pt': 'portuguese',
    'zh-cn': 'chinese_simplified',
    'zh-tw': 'chinese_traditional',
    'zh-hk': 'chinese_cantonese',
    'es-mx': 'spanish_latin_america',
    'es-es': 'spanish_spain',
    'fr-ca': 'french_canada',
    'fr-fr': 'french_france'
};

// SubDL uses uppercase codes (e.g., 'EN', 'FR', 'BR_PT')
// Map SubDL code → ISO 639-1 (alpha2)
const SUBDL_CODE_MAP = {
    'AR': 'ar',      // Arabic
    'BR_PT': 'pt',   // Brazilian Portuguese (maps to Portuguese base; pt-BR handled via regional)
    'DA': 'da',      // Danish
    'NL': 'nl',      // Dutch
    'EN': 'en',      // English
    'FA': 'fa',      // Farsi/Persian
    'FI': 'fi',      // Finnish
    'FR': 'fr',      // French
    'ID': 'id',      // Indonesian
    'IT': 'it',      // Italian
    'NO': 'no',      // Norwegian
    'RO': 'ro',      // Romanian
    'ES': 'es',      // Spanish
    'SV': 'sv',      // Swedish
    'VI': 'vi',      // Vietnamese
    'SQ': 'sq',      // Albanian
    'AZ': 'az',      // Azerbaijani
    'BE': 'be',      // Belarusian
    'BN': 'bn',      // Bengali
    'ZH_BG': 'zh',   // Chinese (Big 5 / Traditional)
    'BS': 'bs',      // Bosnian
    'BG': 'bg',      // Bulgarian
    'MY': 'my',      // Burmese
    'CA': 'ca',      // Catalan
    'ZH': 'zh',      // Chinese (BG code / Simplified)
    'HR': 'hr',      // Croatian
    'CS': 'cs',      // Czech
    'EO': 'eo',      // Esperanto
    'ET': 'et',      // Estonian
    'KA': 'ka',      // Georgian
    'DE': 'de',      // German
    'EL': 'el',      // Greek
    'KL': 'kl',      // Greenlandic
    'HE': 'he',      // Hebrew
    'HI': 'hi',      // Hindi
    'HU': 'hu',      // Hungarian
    'IS': 'is',      // Icelandic
    'JA': 'ja',      // Japanese
    'KO': 'ko',      // Korean
    'KU': 'ku',      // Kurdish
    'LV': 'lv',      // Latvian
    'LT': 'lt',      // Lithuanian
    'MK': 'mk',      // Macedonian
    'MS': 'ms',      // Malay
    'ML': 'ml',      // Malayalam
    'PL': 'pl',      // Polish
    'PT': 'pt',      // Portuguese
    'RU': 'ru',      // Russian
    'SR': 'sr',      // Serbian
    'SI': 'si',      // Sinhala
    'SK': 'sk',      // Slovak
    'SL': 'sl',      // Slovenian
    'TL': 'tl',      // Tagalog
    'TA': 'ta',      // Tamil
    'TE': 'te',      // Telugu
    'TH': 'th',      // Thai
    'TR': 'tr',      // Turkish
    'UK': 'uk',      // Ukrainian
    'UR': 'ur',      // Urdu
    'BG_EN': 'bg',   // Bulgarian + English
    'NL_EN': 'nl',   // Dutch + English
    'EN_DE': 'en',   // English + German
    'HU_EN': 'hu',   // Hungarian + English
};

// Reverse: alpha2 → SubDL code
const SUBDL_ALPHA2_TO_CODE = {
    'ar': 'AR', 'da': 'DA', 'nl': 'NL', 'en': 'EN', 'fa': 'FA',
    'fi': 'FI', 'fr': 'FR', 'id': 'ID', 'it': 'IT', 'no': 'NO',
    'ro': 'RO', 'es': 'ES', 'sv': 'SV', 'vi': 'VI', 'sq': 'SQ',
    'az': 'AZ', 'be': 'BE', 'bn': 'BN', 'bs': 'BS', 'bg': 'BG',
    'my': 'MY', 'ca': 'CA', 'zh': 'ZH', 'hr': 'HR', 'cs': 'CS',
    'eo': 'EO', 'et': 'ET', 'ka': 'KA', 'de': 'DE', 'el': 'EL',
    'kl': 'KL', 'he': 'HE', 'hi': 'HI', 'hu': 'HU', 'is': 'IS',
    'ja': 'JA', 'ko': 'KO', 'ku': 'KU', 'lv': 'LV', 'lt': 'LT',
    'mk': 'MK', 'ms': 'MS', 'ml': 'ML', 'pl': 'PL', 'pt': 'PT',
    'ru': 'RU', 'sr': 'SR', 'si': 'SI', 'sk': 'SK', 'sl': 'SL',
    'tl': 'TL', 'ta': 'TA', 'te': 'TE', 'th': 'TH', 'tr': 'TR',
    'uk': 'UK', 'ur': 'UR',
};

// ============================================================
// LOOKUP FUNCTIONS
// ============================================================

/**
 * Get language by ISO 639-1 (2-letter) code
 * @param {string} code - 2-letter code (e.g., 'en', 'es', 'fr')
 * @returns {Object|null} Language object or null
 */
function getByAlpha2(code) {
    if (!code) return null;
    const idx = _indexByAlpha2.get(code.toLowerCase());
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by ISO 639-2/B (3-letter bibliographic) code
 * This is the Stremio standard
 * @param {string} code - 3-letter B code (e.g., 'eng', 'spa', 'fre', 'ger')
 * @returns {Object|null} Language object or null
 */
function getByAlpha3B(code) {
    if (!code) return null;
    const idx = _indexByAlpha3B.get(code.toLowerCase());
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by ISO 639-2/T (3-letter terminology) code
 * @param {string} code - 3-letter T code (e.g., 'eng', 'spa', 'fra', 'deu')
 * @returns {Object|null} Language object or null
 */
function getByAlpha3T(code) {
    if (!code) return null;
    // First check T-specific index, then fall back to B (most are same)
    let idx = _indexByAlpha3T.get(code.toLowerCase());
    if (idx === undefined) {
        idx = _indexByAlpha3B.get(code.toLowerCase());
    }
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by English name
 * @param {string} name - Full English name (e.g., 'English', 'Spanish')
 * @returns {Object|null} Language object or null
 */
function getByName(name) {
    if (!name) return null;
    const idx = _indexByName.get(name.toLowerCase());
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by YIFY/YTS code (full language name)
 * @param {string} code - YIFY code (e.g., 'english', 'spanish', 'brazilian')
 * @returns {Object|null} Language object or null
 */
function getByYifyCode(code) {
    if (!code) return null;
    const idx = _indexByYify.get(code.toLowerCase());
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by TVsubtitles code
 * @param {string} code - TVsubtitles code (e.g., 'en', 'es', 'gr' for Greek)
 * @returns {Object|null} Language object or null
 */
function getByTvsubtitlesCode(code) {
    if (!code) return null;
    // Try TVsubtitles-specific first, then fall back to alpha2
    let idx = _indexByTvsubtitles.get(code.toLowerCase());
    if (idx === undefined) {
        idx = _indexByAlpha2.get(code.toLowerCase());
    }
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by BetaSeries code
 * @param {string} code - BetaSeries code (e.g., 'vo', 'vf')
 * @returns {Object|null} Language object or null
 */
function getByBetaseriesCode(code) {
    if (!code) return null;
    const idx = _indexByBetaseries.get(code.toLowerCase());
    return idx !== undefined ? LANGUAGE_TABLE[idx] : null;
}

/**
 * Get language by SubSource code
 * @param {string} code - SubSource code (e.g., 'english', 'french', 'brazilian_portuguese')
 * @returns {Object|null} Language object or null
 */
function getBySubsourceCode(code) {
    if (!code) return null;
    const lower = code.toLowerCase();
    
    // First check explicit providerCodes.subsource
    const idx = _indexBySubsource.get(lower);
    if (idx !== undefined) return LANGUAGE_TABLE[idx];
    
    // Then check by language name (SubSource uses lowercase names)
    const nameIdx = _indexByName.get(lower);
    if (nameIdx !== undefined) return LANGUAGE_TABLE[nameIdx];
    
    // Handle regional variants (e.g., 'brazilian_portuguese' -> Portuguese)
    // Map SubSource regional codes back to their base language
    const SUBSOURCE_REGIONAL_TO_BASE = {
        'brazilian_portuguese': 'pt',
        'chinese_simplified': 'zh',
        'chinese_traditional': 'zh',
        'chinese_cantonese': 'zh',
        'spanish_latin_america': 'es',
        'spanish_spain': 'es',
        'french_canada': 'fr',
        'french_france': 'fr'
    };
    
    if (SUBSOURCE_REGIONAL_TO_BASE[lower]) {
        const baseAlpha2 = SUBSOURCE_REGIONAL_TO_BASE[lower];
        const baseIdx = _indexByAlpha2.get(baseAlpha2);
        if (baseIdx !== undefined) return LANGUAGE_TABLE[baseIdx];
    }
    
    return null;
}

/**
 * Get language by SubDL code (e.g., 'EN', 'FR', 'BR_PT')
 */
function getBySubdlCode(code) {
    if (!code) return null;

    const alpha2 = SUBDL_CODE_MAP[code.toUpperCase()];
    if (alpha2) {
        const idx = _indexByAlpha2.get(alpha2.toLowerCase());
        if (idx !== undefined) return LANGUAGE_TABLE[idx];
    }

    const nameIdx = _indexByName.get(code.toLowerCase());
    if (nameIdx !== undefined) return LANGUAGE_TABLE[nameIdx];

    return null;
}

/**
 * Convert any SubSense code to SubDL API format
 */
function toSubdlCode(code) {
    if (!code) return null;
    const lower = code.toLowerCase();
    
    if (lower === 'pt-br') return 'BR_PT';
    if (lower === 'zh-tw' || lower === 'zh-hk') return 'ZH_BG';
    if (lower === 'zh-cn') return 'ZH';
    
    const lang = getByAnyCode(code);
    if (!lang) return null;
    
    const subdlCode = SUBDL_ALPHA2_TO_CODE[lang.alpha2];
    return subdlCode || null;
}

/**
 * Special code mappings for provider-specific codes not in ISO standards
 * OpenSubtitles and other providers use non-standard codes
 */
const SPECIAL_CODE_MAPPINGS = {
    'pb': 'pt-BR',      // OpenSubtitles Brazilian Portuguese
    'pob': 'pt-BR',     // Alternative Brazilian Portuguese
    'cn': 'zh',         // Chinese (simplified shorthand)
    'tw': 'zh',         // Chinese (Taiwan/Traditional)
    'br': 'pt-BR',      // Brazilian Portuguese (TVsubtitles)
    'gr': 'el',         // Greek (TVsubtitles uses 'gr' instead of 'el')
    'nb': 'no',         // Norwegian Bokmål -> Norwegian
    'nn': 'no',         // Norwegian Nynorsk -> Norwegian
    'ze': 'zh',         // Chinese (simplified - legacy)
    'zt': 'zh',         // Chinese (traditional - legacy)
};

/**
 * Universal lookup - tries all code types
 * @param {string} code - Any language code
 * @returns {Object|null} Language object or null
 */
function getByAnyCode(code) {
    if (!code) return null;
    const lowerCode = code.toLowerCase();
    
    // Check special mappings first
    if (SPECIAL_CODE_MAPPINGS[lowerCode]) {
        const mappedCode = SPECIAL_CODE_MAPPINGS[lowerCode];
        return getByAlpha2(mappedCode) || getByAlpha3B(mappedCode);
    }
    
    // Try in order of specificity
    return getByAlpha3B(lowerCode) ||
           getByAlpha3T(lowerCode) ||
           getByAlpha2(lowerCode) ||
           getByYifyCode(lowerCode) ||
           getByTvsubtitlesCode(lowerCode) ||
           getByBetaseriesCode(lowerCode) ||
           getBySubdlCode(code) ||
           getByName(code) ||
           null;
}

// ============================================================
// CONVERSION FUNCTIONS
// ============================================================

/**
 * Convert any code to ISO 639-2/B (Stremio standard)
 * @param {string} code - Any language code
 * @returns {string|null} 3-letter B code or null
 */
function toAlpha3B(code) {
    const lang = getByAnyCode(code);
    return lang ? lang.alpha3B : null;
}

/**
 * Convert any code to ISO 639-1 (2-letter)
 * @param {string} code - Any language code
 * @returns {string|null} 2-letter code or null
 */
function toAlpha2(code) {
    const lang = getByAnyCode(code);
    return lang ? lang.alpha2 : null;
}

/**
 * Convert any code to YIFY format
 * @param {string} code - Any language code
 * @returns {string|null} YIFY code or null
 */
function toYifyCode(code) {
    const lang = getByAnyCode(code);
    if (!lang) return null;
    return lang.providerCodes?.yify || lang.name.toLowerCase();
}

/**
 * Convert any code to TVsubtitles format
 * @param {string} code - Any language code
 * @returns {string|null} TVsubtitles code or null
 */
function toTvsubtitlesCode(code) {
    const lang = getByAnyCode(code);
    if (!lang) return null;
    return lang.providerCodes?.tvsubtitles || lang.alpha2;
}

/**
 * Convert any code to BetaSeries format
 * @param {string} code - Any language code
 * @returns {string|null} BetaSeries code or null
 */
function toBetaseriesCode(code) {
    const lang = getByAnyCode(code);
    if (!lang) return null;
    return lang.providerCodes?.betaseries || null;
}

/**
 * Convert any code to SubSource format
 * SubSource uses full lowercase language names (e.g., 'english', 'french')
 * Also handles regional variants (e.g., 'pt-br' -> 'brazilian_portuguese')
 * @param {string} code - Any language code (ISO or regional like 'pt-br')
 * @returns {string|null} SubSource code or null
 */
function toSubsourceCode(code) {
    if (!code) return null;
    const lower = code.toLowerCase();
    
    // Check regional variants first
    if (SUBSOURCE_REGIONAL_MAP[lower]) {
        return SUBSOURCE_REGIONAL_MAP[lower];
    }
    
    // Check direct alpha2 mapping
    if (SUBSOURCE_LANGUAGE_MAP[lower]) {
        return SUBSOURCE_LANGUAGE_MAP[lower];
    }
    
    // Try to get language from any code format
    const lang = getByAnyCode(code);
    if (!lang) return null;
    
    // Check if providerCodes.subsource is defined
    if (lang.providerCodes?.subsource) {
        return lang.providerCodes.subsource;
    }
    
    // Fall back to language map using alpha2
    if (SUBSOURCE_LANGUAGE_MAP[lang.alpha2]) {
        return SUBSOURCE_LANGUAGE_MAP[lang.alpha2];
    }
    
    // Last resort: lowercase language name (may or may not work)
    return lang.name.toLowerCase();
}

/**
 * Get display name for any language code
 * @param {string} code - Any language code
 * @returns {string} Display name or code uppercase if not found
 */
function getDisplayName(code) {
    if (!code || code === 'none') return 'None';
    const lang = getByAnyCode(code);
    return lang ? lang.name : code.toUpperCase();
}

/**
 * Get native name for any language code
 * @param {string} code - Any language code
 * @returns {string|null} Native name or null
 */
function getNativeName(code) {
    const lang = getByAnyCode(code);
    return lang ? lang.nativeName : null;
}

// ============================================================
// UTILITY FUNCTIONS (Backwards compatibility)
// ============================================================

/**
 * Get all supported languages for frontend dropdown
 * @returns {Array<{code: string, name: string}>}
 */
function getAllLanguages() {
    return LANGUAGE_TABLE.map(lang => ({
        code: lang.alpha3B,
        name: lang.name
    }));
}

/**
 * Get common subtitle languages (smaller list for quick access)
 * @returns {Array<{code: string, name: string}>}
 */
function getCommonLanguages() {
    const commonCodes = [
        'eng', 'spa', 'fre', 'ger', 'por', 'ita', 'rus', 'jpn', 'kor', 'chi',
        'ara', 'hin', 'tur', 'pol', 'dut', 'swe', 'nor', 'dan', 'fin', 'gre',
        'heb', 'cze', 'hun', 'rum', 'bul', 'ukr', 'tha', 'vie', 'ind', 'may'
    ];
    
    return commonCodes.map(code => {
        const lang = getByAlpha3B(code);
        return lang ? { code: lang.alpha3B, name: lang.name } : null;
    }).filter(Boolean);
}

/**
 * Validate if a code is a valid language code
 * @param {string} code - Any language code
 * @returns {boolean}
 */
function isValidLanguage(code) {
    if (!code) return false;
    if (code === 'none') return true;
    return getByAnyCode(code) !== null;
}

/**
 * Map Wyzie (2-letter) to Stremio (3-letter B)
 * Backwards compatibility alias
 * @param {string} wyzieCode - 2-letter code
 * @returns {string} 3-letter B code or 'und'
 */
function mapWyzieToStremio(wyzieCode) {
    if (!wyzieCode) return 'und';
    return toAlpha3B(wyzieCode) || wyzieCode;
}

/**
 * Map Stremio/config code to Wyzie (2-letter base)
 * Strips region codes since Wyzie only accepts base 2-letter codes
 * e.g., "pt-BR" → "pt", "zh-TW" → "zh"
 * @param {string} code - Any language code (2-letter, 3-letter, or with region)
 * @returns {string|null} Base 2-letter code for Wyzie API
 */
function mapStremioToWyzie(code) {
    if (!code || code === 'none') return null;
    const alpha2 = toAlpha2(code);
    if (!alpha2) return null;
    // Strip region code if present (e.g., "pt-BR" → "pt")
    return alpha2.split('-')[0].toLowerCase();
}

/**
 * Normalize language code to ISO 639-2/B
 * @param {string} code - Any language code
 * @returns {string} Normalized B code or original
 */
function normalizeLanguageCode(code) {
    if (!code || code === 'none') return code;
    return toAlpha3B(code) || code.toLowerCase();
}

/**
 * Get language name from code
 * Backwards compatibility alias
 * @param {string} code - Any language code
 * @returns {string} Language name
 */
function getLanguageName(code) {
    return getDisplayName(code);
}

/**
 * Get list of supported languages
 * Backwards compatibility alias
 * @returns {Array<{code: string, name: string}>}
 */
function getSupportedLanguages() {
    return getCommonLanguages();
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    // Master data
    LANGUAGE_TABLE,
    SPECIAL_CODE_MAPPINGS,
    SUBSOURCE_LANGUAGE_MAP,
    SUBSOURCE_REGIONAL_MAP,
    SUBDL_CODE_MAP,
    SUBDL_ALPHA2_TO_CODE,
    
    // Lookup functions
    getByAlpha2,
    getByAlpha3B,
    getByAlpha3T,
    getByName,
    getByYifyCode,
    getByTvsubtitlesCode,
    getByBetaseriesCode,
    getBySubsourceCode,
    getBySubdlCode,
    getByAnyCode,
    
    // Conversion functions
    toAlpha3B,
    toAlpha2,
    toYifyCode,
    toTvsubtitlesCode,
    toBetaseriesCode,
    toSubsourceCode,
    toSubdlCode,
    getDisplayName,
    getNativeName,
    
    // Utility functions
    getAllLanguages,
    getCommonLanguages,
    isValidLanguage,
    normalizeLanguageCode,
    
    // Backwards compatibility aliases
    mapWyzieToStremio,
    mapStremioToWyzie,
    getLanguageName,
    getSupportedLanguages
};
