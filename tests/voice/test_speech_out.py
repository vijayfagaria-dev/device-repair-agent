"""Speech output (P5-T11): the sentence chunker, and one agent turn through the fake TTS.

The transcript line grows with what is sent and ends equal to it, audio goes out tagged and timed, and cancel() stops at
once (P5-T07).
"""

from __future__ import annotations

from app.agent.sentence_chunker import LONG_CHUNK_CHARS, SentenceChunker
from app.protocol.types import AudioMessage, TranscriptMessage
from app.voice.clock import ManualClock
from app.voice.fakes.tts import FAKE_FRAME_MS, FakeTts, FakeTtsOptions
from app.voice.speech_out import INTERRUPTED_MARK, CallMessage, Chunk, SpeechTurn, heard_text
from app.voice.types import TtsEvent


def chunks(*deltas: str) -> list[str]:
    chunker = SentenceChunker()
    return [*[c for d in deltas for c in chunker.push(d)], *chunker.flush()]


class TestSentenceChunker:
    def test_cuts_at_sentence_ends_followed_by_a_space_across_streamed_pieces(self) -> None:
        assert chunks("Got it", ", a Sam", "sung. When did it ", "start? Thanks", "!") == [
            "Got it, a Samsung.",
            "When did it start?",
            "Thanks!",
        ]

    def test_doesnt_cut_after_abbreviations_initials_or_inside_numbers(self) -> None:
        assert chunks("Dr. Rao said e.g. the 1.5 GHz model works. Okay.") == [
            "Dr. Rao said e.g. the 1.5 GHz model works.",
            "Okay.",
        ]
        assert chunks("Thanks, A. Rao. Next.") == ["Thanks, A. Rao.", "Next."]

    def test_cuts_a_long_sentence_at_a_comma_so_speech_starts_early(self) -> None:
        long = f"{'word ' * 22}more words, and then the rest of a very long sentence without a stop"
        first, *rest = chunks(long)
        assert len(long) > LONG_CHUNK_CHARS
        assert first.endswith(",")
        assert "and then the rest" in " ".join(rest)


def transcripts(sent: list[CallMessage]) -> list[TranscriptMessage]:
    return [m for m in sent if isinstance(m, TranscriptMessage)]


class Rig:
    """A speech turn wired to a fake TTS on a manual clock."""

    def __init__(self, options: FakeTtsOptions | None = None) -> None:
        self.clock = ManualClock()
        self.tts = FakeTts(options if options is not None else FakeTtsOptions(clock=self.clock))
        self.sent: list[CallMessage] = []
        self.speech: SpeechTurn | None = None

    async def start(self) -> SpeechTurn:
        def on_event(event: TtsEvent) -> None:
            if self.speech is not None:
                self.speech.on_tts(event)

        await self.tts.open(on_event)
        self.speech = SpeechTurn("ta_c1_1", self.tts.current, self.clock, self.sent.append)
        return self.speech


class TestSpeechTurn:
    async def test_the_agent_line_grows_with_each_chunk_sent_and_its_final_text_is_what_was_spoken_first_audio_is_recorded(
        self,
    ) -> None:
        rig = Rig()
        speech = await rig.start()
        first_speak_at = rig.clock.now()
        speech.say("Got it, a Samsung. ")
        speech.say("When did it start?")
        speech.end()
        await rig.clock.tick(5_000)
        spoken = await speech.done
        lines = transcripts(rig.sent)
        assert [(m.text, m.final) for m in lines] == [
            ("Got it, a Samsung.", False),
            ("Got it, a Samsung. When did it start?", False),
            ("Got it, a Samsung. When did it start?", True),
        ]
        assert rig.tts.current.spoken() == "Got it, a Samsung. When did it start?"
        assert (spoken.id, spoken.text, spoken.interrupted, spoken.characters) == (
            "ta_c1_1",
            "Got it, a Samsung. When did it start?",
            False,
            36,
        )
        assert spoken.first_audio_at is not None
        # Time to first byte runs from the first text sent to TTS to the first audio back (P11-T02).
        assert spoken.tts_ttfb_ms == spoken.first_audio_at - first_speak_at
        assert spoken.tts_ttfb_ms >= 0
        assert all(m.sample_rate == 24000 for m in rig.sent if isinstance(m, AudioMessage))

    async def test_cancel_no_audio_after_it_the_line_is_cut_at_what_was_heard_and_marked_interrupted(self) -> None:
        rig = Rig()
        rig.tts = FakeTts(FakeTtsOptions(clock=rig.clock, chars_per_frame=2))
        speech = await rig.start()
        text = "The first sentence is short. The second one is much longer and keeps going for a while."
        speech.say(text)
        speech.end()
        await rig.clock.tick(FAKE_FRAME_MS * 20)  # about 0.8 s of audio played
        audio_before = len([m for m in rig.sent if isinstance(m, AudioMessage)])
        result = speech.cancel()
        await rig.clock.tick(3_000)
        assert len([m for m in rig.sent if isinstance(m, AudioMessage)]) == audio_before  # 0 frames after cancel
        assert rig.tts.current.cancelled_turns == ["ta_c1_1"]
        assert result.interrupted is True
        assert len(result.heard) > 0
        assert text.startswith(result.heard)
        assert len(result.heard) < 60
        last = rig.sent[-1]
        assert isinstance(last, TranscriptMessage)
        assert last.final is True and last.text == f"{result.heard}{INTERRUPTED_MARK}"
        assert await speech.done is result

    def test_heard_text_whole_chunks_while_their_audio_played_then_a_cut_at_a_word_boundary(self) -> None:
        c = [Chunk("Got it.", 500), Chunk("When did the problem start?", 1000)]
        assert heard_text(c, 0) == ""
        assert heard_text(c, 500) == "Got it."
        assert heard_text(c, 1000) == "Got it. When did the"
        assert heard_text(c, 5000) == "Got it. When did the problem start?"

    def test_heard_text_a_chunk_still_arriving_is_as_long_as_its_text_at_the_finished_chunks_rate(self) -> None:
        c = [
            Chunk("Got it.", 700, complete=True),  # 100 ms per character
            Chunk("When did the problem start?", 300, complete=False),  # 27 chars: about 2.7 s
        ]
        assert heard_text(c, 1_000) == "Got it."
        assert heard_text(c, 2_000) == "Got it. When did the"


class TestP5ReviewFixesSpeechOutput:
    async def test_9_playback_follows_a_cursor_a_gap_in_the_audio_doesnt_count_as_played_break_chunk_speaks_the_held_text(
        self,
    ) -> None:
        rig = Rig(FakeTtsOptions())
        speech = await rig.start()
        speech.say("Got it, Apple iPhone 14 Pro.")
        assert rig.tts.current.chunks == []  # held: no space after the stop yet
        speech.break_chunk()
        assert [text for _, text in rig.tts.current.chunks] == ["Got it, Apple iPhone 14 Pro."]
        end1 = speech.playback_ends_at()
        await rig.clock.tick(3_000)  # a 3 s gap (the follow-up call), the first chunk long played
        speech.say("What's wrong with it?")
        speech.end()
        # The new chunk plays from its arrival (now), not from the first frame: the old estimate (first frame + all audio
        # sent = end1 + 240 ms) would already lie in the past and report "not speaking".
        assert speech.playback_ends_at() == rig.clock.now() + 240
        assert end1 + 240 < rig.clock.now()
        assert speech.speaking is True
