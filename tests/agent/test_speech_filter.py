"""Live-call regressions (sessions 51ba, 5db2, 5efb, 2026-11-11): markup, invisible characters and filler loops."""

from __future__ import annotations

from app.agent.speech_filter import SpeechFilter, clean_speech


class TestSpeechFilter:
    def test_drops_prompt_markup_even_when_split_across_deltas(self) -> None:
        f = SpeechFilter()
        out = "".join(f.push(d) for d in ["Got it, <customer_wo", 'rds field="deviceModel">', ". Next?"])
        assert out == "Got it, . Next?"

    def test_keeps_a_stray_lt_that_never_closes(self) -> None:
        assert "a" in clean_speech(f"a < b {'x' * 200}")

    def test_separates_glued_sentences(self) -> None:
        assert clean_speech("When did it start?How urgent is it?") == "When did it start? How urgent is it?"
        f = SpeechFilter()
        assert f.push("in the chat.") + f.push("When you are ready") + f.flush() == "in the chat. When you are ready"

    def test_does_not_split_abbreviations_or_numbers(self) -> None:
        assert clean_speech("In the U.S.A. it is 3.5 inches") == "In the U.S.A. it is 3.5 inches"

    def test_removes_zero_width_characters(self) -> None:
        assert clean_speech("Hel​​lo") == "Hello"

    def test_flags_runaway_filler_as_degenerate_and_collapses_it(self) -> None:
        f = SpeechFilter()
        out = f.push(f"Check {'… \n\n ... … ' * 10}")
        assert f.degenerate is True
        assert len(out) < 40

    def test_does_not_flag_normal_speech(self) -> None:
        f = SpeechFilter()
        f.push("Okay... let me check that for you. One moment.")
        assert f.degenerate is False


class TestInternalNames:
    def test_never_speaks_field_ids_or_state_keys(self) -> None:
        assert (
            clean_speech("I have saved your deviceModel and the problemStartedAt, readyToSubmit is true.")
            == "I have saved your device model and the start date, is true."
        )

    def test_catches_a_name_split_across_streamed_pieces_and_flushes_the_last_word(self) -> None:
        f = SpeechFilter()
        out = "".join(f.push(d) for d in ["Your device", "Model is set. Now the ser", "ialNumber"]) + f.flush()
        assert out == "Your device model is set. Now the serial number"


class TestMarkdown:
    def test_never_speaks_emphasis_marks(self) -> None:
        assert (
            clean_speech("Check the chat and tap **Yes** to submit your `claim`.")
            == "Check the chat and tap Yes to submit your claim."
        )

    def test_catches_marks_split_across_streamed_pieces(self) -> None:
        f = SpeechFilter()
        assert "".join(f.push(d) for d in ["tap *", "*Yes*", "* now"]) + f.flush() == "tap Yes now"
