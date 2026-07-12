"""F2: de-identification round-trip tests — the unit-tested guarantee that
names/phones/emails never leave the process and always come back intact."""

from app.deid import Deidentifier


def test_registered_name_scrubs_and_rehydrates():
    d = Deidentifier()
    d.register_person("Maria Gomez")
    scrubbed = d.scrub("Hi Maria Gomez, your crown is ready. — for Maria Gomez")
    assert "Maria" not in scrubbed
    assert "Gomez" not in scrubbed
    assert "[PATIENT_1]" in scrubbed
    assert d.rehydrate(scrubbed) == "Hi Maria Gomez, your crown is ready. — for Maria Gomez"


def test_name_parts_scrub_individually():
    d = Deidentifier()
    d.register_person("Maria Gomez")
    scrubbed = d.scrub("Hi Maria, see you soon. Regards to the Gomez family.")
    assert "Maria" not in scrubbed
    assert "Gomez" not in scrubbed
    # Parts round-trip to their own original substrings.
    assert d.rehydrate(scrubbed) == "Hi Maria, see you soon. Regards to the Gomez family."


def test_deterministic_tokens_within_request():
    d = Deidentifier()
    d.register_person("Maria Gomez")
    d.register_person("John Smith")
    a = d.scrub("Maria Gomez and John Smith")
    b = d.scrub("John Smith and Maria Gomez")
    # Same entity ⇒ same token across every message of the request.
    assert a.split(" and ")[0] == b.split(" and ")[1]


def test_phone_and_email_caught_by_pattern():
    d = Deidentifier()
    text = "Call me at (512) 555-0134 or email maria.g@example.com please"
    scrubbed = d.scrub(text)
    assert "555-0134" not in scrubbed
    assert "maria.g@example.com" not in scrubbed
    assert "[PHONE_1]" in scrubbed
    assert "[EMAIL_1]" in scrubbed
    assert d.rehydrate(scrubbed) == text


def test_unregistered_short_words_untouched():
    d = Deidentifier()
    d.register_person("Al")  # below the minimum part length — must not register
    scrubbed = d.scrub("Al can be scheduled at 3pm; also fix the algorithm")
    assert scrubbed == "Al can be scheduled at 3pm; also fix the algorithm"


def test_case_insensitive_scrub_preserves_original_on_rehydrate():
    d = Deidentifier()
    d.register_person("Maria Gomez")
    scrubbed = d.scrub("MARIA GOMEZ confirmed.")
    assert "MARIA" not in scrubbed
    # Rehydration restores the registered casing (the platform's canonical value).
    assert d.rehydrate(scrubbed) == "Maria Gomez confirmed."


def test_substring_inside_word_not_scrubbed():
    d = Deidentifier()
    d.register_person("Ann Lee")
    scrubbed = d.scrub("The anniversary sleeve arrived for Ann Lee")
    assert scrubbed.startswith("The anniversary sleeve arrived")
    assert "Ann Lee" not in scrubbed


def test_llm_output_rehydration_shape():
    """Simulates the invoke_structured path: scrub → model answers using the
    tokens → recursive rehydrate over a pydantic result."""
    from pydantic import BaseModel

    from app.llm import _rehydrate

    class Out(BaseModel):
        message: str
        picks: list[str]

    d = Deidentifier()
    d.register_person("Maria Gomez")
    d.scrub("Draft an SMS for Maria Gomez")
    out = Out(message="Hi [PATIENT_1], your slot is ready", picks=["[PATIENT_1] first"])
    out = _rehydrate(out, d)
    assert out.message == "Hi Maria Gomez, your slot is ready"
    assert out.picks == ["Maria Gomez first"]
