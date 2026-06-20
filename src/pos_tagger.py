"""Lightweight part-of-speech tagger for subtitle styling.

Identifies nouns and verbs without external NLP dependencies.
Uses heuristics:
- German: capitalized words (except sentence start) are nouns
- Common verb lists for German and English
- Fallback: words > 5 chars with common noun/verb suffixes
"""

# Common German verbs (infinitive + conjugated forms of frequent verbs)
_DE_VERBS = {
    # sein
    "bin", "bist", "ist", "sind", "seid", "war", "warst", "waren", "wart",
    "gewesen", "sei", "wäre", "wärst", "wären", "wärt",
    # haben
    "habe", "hast", "hat", "haben", "habt", "hatte", "hattest", "hatten",
    "hattet", "gehabt", "hätte", "hättest", "hätten", "hättet",
    # werden
    "werde", "wirst", "wird", "werden", "werdet", "wurde", "wurdest",
    "wurden", "wurdet", "geworden", "würde", "würdest", "würden", "würdet",
    # modal
    "kann", "kannst", "können", "könnt", "konnte", "konntest", "konnten",
    "konntet", "gekonnt", "könnte", "könntest", "könnten", "könntet",
    "muss", "musst", "müssen", "müsst", "musste", "musstest", "mussten",
    "musstet", "gemusst", "müsste", "müsstest", "müssten", "müsstet",
    "soll", "sollst", "sollen", "sollt", "sollte", "solltest", "sollten",
    "solltet", "gesollt",
    "will", "willst", "wollen", "wollt", "wollte", "wolltest", "wollten",
    "wolltet", "gewollt",
    "darf", "darfst", "dürfen", "dürft", "durfte", "durftest", "durften",
    "durftet", "gedurft", "dürfte", "dürftest", "dürften", "dürftet",
    "mag", "magst", "mögen", "mögt", "mochte", "mochtest", "mochten",
    "mochtet", "gemocht", "möchte", "möchtest", "möchten", "möchtet",
    # common
    "machen", "machst", "macht", "gemacht", "gehen", "gehst", "geht",
    "gegangen", "kommen", "kommst", "kommt", "gekommen", "sagen", "sagst",
    "sagt", "gesagt", "geben", "gibst", "gibt", "gegeben", "nehmen",
    "nimmst", "nimmt", "genommen", "sehen", "siehst", "sieht", "gesehen",
    "finden", "findest", "findet", "gefunden", "wissen", "weißt", "weiß",
    "gewusst", "denken", "denkst", "denkt", "gedacht", "glauben", "glaubst",
    "glaubt", "geglaubt", "brauchen", "brauchst", "braucht", "gebraucht",
    "heißen", "heißt", "geheißen", "stehen", "stehst", "steht", "gestanden",
    "liegen", "liegst", "liegt", "gelegen", "sitzen", "sitzt", "gesessen",
    "lassen", "lässt", "gelassen", "bleiben", "bleibst", "bleibt",
    "geblieben", "sprechen", "sprichst", "spricht", "gesprochen",
    "halten", "hältst", "hält", "gehalten", "zeigen", "zeigst", "zeigt",
    "gezeigt", "führen", "führst", "führt", "geführt", "bringen", "bringst",
    "bringt", "gebracht", "lesen", "liest", "gelesen", "laufen", "läufst",
    "läuft", "gelaufen", "spielen", "spielst", "spielt", "gespielt",
    "arbeiten", "arbeitest", "arbeitet", "gearbeitet", "versuchen",
    "versuchst", "versucht", "kaufen", "kaufst", "kauft", "gekauft",
    "nutzen", "nutzt", "genutzt", "benutzen", "benutzt", "benutzt",
    "schauen", "schaust", "schaut", "geschaut", "erklären", "erklärst",
    "erklärt", "erzählen", "erzählst", "erzählt",
}

# Common English verbs
_EN_VERBS = {
    "is", "am", "are", "was", "were", "been", "being",
    "have", "has", "had", "having",
    "do", "does", "did", "done", "doing",
    "will", "would", "shall", "should", "can", "could", "may", "might",
    "must", "need", "dare",
    "get", "gets", "got", "getting", "gotten",
    "go", "goes", "went", "going", "gone",
    "come", "comes", "came", "coming",
    "make", "makes", "made", "making",
    "know", "knows", "knew", "known", "knowing",
    "think", "thinks", "thought", "thinking",
    "take", "takes", "took", "taken", "taking",
    "see", "sees", "saw", "seen", "seeing",
    "want", "wants", "wanted", "wanting",
    "give", "gives", "gave", "given", "giving",
    "use", "uses", "used", "using",
    "find", "finds", "found", "finding",
    "tell", "tells", "told", "telling",
    "ask", "asks", "asked", "asking",
    "work", "works", "worked", "working",
    "call", "calls", "called", "calling",
    "try", "tries", "tried", "trying",
    "keep", "keeps", "kept", "keeping",
    "let", "lets", "letting",
    "begin", "begins", "began", "begun", "beginning",
    "show", "shows", "showed", "shown", "showing",
    "hear", "hears", "heard", "hearing",
    "play", "plays", "played", "playing",
    "run", "runs", "ran", "running",
    "move", "moves", "moved", "moving",
    "live", "lives", "lived", "living",
    "believe", "believes", "believed", "believing",
    "bring", "brings", "brought", "bringing",
    "happen", "happens", "happened", "happening",
    "write", "writes", "wrote", "written", "writing",
    "provide", "provides", "provided", "providing",
    "sit", "sits", "sat", "sitting",
    "stand", "stands", "stood", "standing",
    "lose", "loses", "lost", "losing",
    "pay", "pays", "paid", "paying",
    "meet", "meets", "met", "meeting",
    "include", "includes", "included", "including",
    "continue", "continues", "continued", "continuing",
    "learn", "learns", "learned", "learning",
    "change", "changes", "changed", "changing",
    "watch", "watches", "watched", "watching",
    "follow", "follows", "followed", "following",
    "stop", "stops", "stopped", "stopping",
    "create", "creates", "created", "creating",
    "speak", "speaks", "spoke", "spoken", "speaking",
    "read", "reads", "reading",
    "build", "builds", "built", "building",
    "buy", "buys", "bought", "buying",
    "sell", "sells", "sold", "selling",
}

# Words that should NOT be tagged as nouns despite capitalization (German)
_DE_NOT_NOUNS = {
    "ich", "du", "er", "sie", "es", "wir", "ihr", "die", "der", "das",
    "den", "dem", "des", "ein", "eine", "einen", "einem", "einer", "eines",
    "und", "oder", "aber", "denn", "weil", "dass", "wenn", "als", "ob",
    "wie", "wo", "wer", "was", "welche", "welcher", "welches",
    "mit", "von", "zu", "an", "auf", "in", "für", "über", "unter",
    "nach", "vor", "zwischen", "durch", "ohne", "gegen", "um", "bis",
    "nicht", "kein", "keine", "keinen", "keinem", "keiner", "keines",
    "ja", "nein", "auch", "noch", "schon", "nur", "sehr", "so", "da",
    "hier", "dort", "dann", "jetzt", "heute", "morgen", "gestern",
    "immer", "nie", "oft", "viel", "mehr", "wenig", "alle", "alles",
    "diese", "dieser", "dieses", "diesen", "diesem", "jede", "jeder",
    "jedes", "jeden", "jedem", "mein", "meine", "meinen", "meinem",
    "dein", "deine", "deinen", "deinem", "sein", "seine", "seinen",
    "seinem", "ihr", "ihre", "ihren", "ihrem", "unser", "unsere",
    "euer", "eure",
}

# Common English nouns
_EN_NOUNS = {
    # People
    "guy", "guys", "man", "men", "woman", "women", "person", "people", "kid",
    "kids", "child", "children", "baby", "boy", "girl", "friend", "friends",
    "family", "team", "group", "audience", "viewer", "viewers", "subscriber",
    "subscribers", "follower", "followers", "fan", "fans",
    # Things
    "thing", "things", "stuff", "way", "ways", "part", "parts", "place",
    "places", "time", "times", "day", "days", "week", "weeks", "month",
    "months", "year", "years", "night", "morning", "world", "life",
    "money", "price", "deal", "idea", "ideas", "problem", "problems",
    "question", "questions", "answer", "answers", "reason", "reasons",
    "point", "example", "fact", "story", "stories", "name", "number",
    # Tech/Media
    "video", "videos", "phone", "camera", "app", "apps", "game", "games",
    "screen", "computer", "laptop", "website", "link", "channel", "content",
    "photo", "photos", "picture", "pictures", "image", "images", "music",
    "song", "songs", "movie", "movies", "episode", "series", "podcast",
    "clip", "thumbnail", "post", "comment", "comments", "update",
    # Body/Food
    "hand", "hands", "eye", "eyes", "face", "head", "body", "heart",
    "food", "water", "coffee", "color", "colours", "color", "colors",
    # Places
    "house", "home", "room", "school", "store", "shop", "city", "country",
    "street", "office", "market", "car", "road", "door", "window",
    # Abstract
    "love", "power", "energy", "level", "quality", "style", "type",
    "experience", "difference", "result", "results", "effect", "effects",
    "version", "feature", "features", "option", "options", "side", "end",
    "start", "top", "bottom", "bit", "lot", "kind", "sort", "set",
    "key", "step", "steps", "goal", "goals", "plan", "value", "job",
    "work", "product", "products", "brand", "tool", "tools", "trick",
    "tricks", "tip", "tips", "secret", "secrets", "hack", "hacks",
}

# English function words (pronouns, articles, prepositions, conjunctions, etc.)
# These stay white in elegant style — everything NOT here gets orange/script
_EN_NOT_NOUNS = {
    # Pronouns
    "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "mine", "yours", "hers", "ours", "theirs",
    "myself", "yourself", "himself", "herself", "itself", "ourselves", "themselves",
    # Articles & demonstratives
    "a", "an", "the", "this", "that", "these", "those",
    # Conjunctions
    "and", "or", "but", "if", "when", "while", "because", "since", "until", "although",
    "though", "unless", "whether", "either", "neither", "nor", "yet",
    # Prepositions
    "in", "on", "at", "to", "for", "with", "from", "by", "about", "into", "through",
    "during", "before", "after", "above", "below", "between", "under", "over",
    "of", "up", "out", "off", "down", "around", "along", "across", "against",
    "upon", "within", "without", "toward", "towards", "beside", "besides",
    # Adverbs & modifiers
    "not", "no", "nor", "so", "too", "very", "just", "also", "still", "already",
    "here", "there", "now", "then", "always", "never", "often", "sometimes",
    "really", "actually", "basically", "literally", "probably", "maybe",
    "definitely", "obviously", "honestly", "seriously", "exactly", "pretty",
    "quite", "rather", "almost", "even", "ever", "like", "right",
    # Determiners & quantifiers
    "all", "every", "each", "some", "any", "many", "much", "few", "more", "most",
    "other", "another", "such", "only", "own", "same", "than", "well",
    # Question words
    "how", "what", "which", "who", "whom", "whose", "where", "why",
    # Filler / discourse
    "oh", "ah", "um", "uh", "ok", "okay", "yeah", "yes", "no", "hi", "hey",
    "hello", "bye", "thanks", "thank", "please", "sorry", "sure", "alright",
    # Common short adjectives/adverbs that aren't nouns
    "good", "bad", "best", "worst", "great", "nice", "fine", "cool", "real",
    "big", "small", "long", "short", "old", "new", "young", "high", "low",
    "hard", "easy", "fast", "slow", "full", "last", "first", "next", "late",
    "early", "free", "true", "false", "whole", "able", "done", "back",
    "little", "different", "important", "certain", "ready", "super",
    # Common adverbs
    "again", "away", "else", "enough", "far", "together", "alone",
    # Linking / auxiliary
    "been", "being", "gonna", "gotta", "wanna", "kinda", "gotta",
    # Age/number related
    "years", "year", "old",
}


def tag_word(word: str, language: str = "de", is_first_word: bool = False) -> str:
    """Tag a single word as 'NOUN', 'VERB', or 'OTHER'.

    Args:
        word: The word to tag.
        language: Language code ('de' or 'en').
        is_first_word: Whether this is the first word in a sentence/phrase.

    Returns:
        'NOUN', 'VERB', or 'OTHER'
    """
    clean = word.strip().strip(".,!?;:\"'()[]…–—-")
    lower = clean.lower()

    if not clean:
        return "OTHER"

    # Check verbs first
    if language == "de" and lower in _DE_VERBS:
        return "VERB"
    if language == "en" and lower in _EN_VERBS:
        return "VERB"

    # Check verb suffixes (German: -en, -st, -te, -tet, -ert)
    if language == "de" and len(lower) > 4:
        if lower.endswith(("ieren", "ieren")):
            return "VERB"

    # Check nouns
    if language == "de":
        # German: capitalized words are nouns (except first word, stop words)
        if lower in _DE_NOT_NOUNS:
            return "OTHER"
        if clean[0].isupper() and not is_first_word:
            return "NOUN"
        # First word: check if it's clearly a noun by suffix
        if clean[0].isupper() and is_first_word:
            # German noun suffixes
            if lower.endswith(("ung", "heit", "keit", "schaft", "tion", "ment",
                              "nis", "tum", "chen", "lein", "ling", "eur",
                              "ist", "ant", "ent")):
                return "NOUN"
            # If not a known stop word and capitalized, likely noun
            if lower not in _DE_NOT_NOUNS and len(clean) > 3:
                return "NOUN"
    elif language == "en":
        # English: only verbs get highlighted (nouns too unreliable without NLP)
        # Verbs already caught above, everything else is OTHER
        pass

    return "OTHER"


def tag_phrase(words: list[str], language: str = "de", global_offset: int = 0) -> list[str]:
    """Tag a list of words, returning list of POS tags.

    For German: uses capitalization + verb list (reliable).
    For other languages: every 3rd word highlighted (using global_offset for continuity).

    Args:
        words: List of words to tag.
        language: Language code.
        global_offset: Word count offset from previous phrases (for continuous pattern).

    Returns:
        List of tags ('NOUN', 'VERB', 'OTHER') matching the input words.
    """
    if language == "de":
        return [tag_word(w, language, is_first_word=(i == 0)) for i, w in enumerate(words)]

    # Non-German: every 3rd word highlighted (continuous across phrases)
    tags = []
    for i, _w in enumerate(words):
        if (global_offset + i + 1) % 3 == 0:
            tags.append("NOUN")
        else:
            tags.append("OTHER")
    return tags
