"""The end-of-utterance event time (P11-T02): the latency clock starts at STT's event, not after the merge window."""

from __future__ import annotations

from dataclasses import dataclass

from app.voice.clock import ManualClock
from app.voice.types import SttTranscript, SttUtteranceEnd
from app.voice.user_turns import UserTurns, Utterance


@dataclass
class Setup:
    clock: ManualClock
    ended: list[Utterance]
    turns: UserTurns

    def say(self, text: str, speech_final: bool = True) -> None:
        self.turns.handle(SttTranscript(text=text, is_final=True, speech_final=speech_final))


def setup() -> Setup:
    clock = ManualClock()
    ended: list[Utterance] = []
    turns = UserTurns(call_id="c1", clock=clock, on_line=lambda line: None, on_turn_end=ended.append)
    return Setup(clock, ended, turns)


class TestUserTurnsEndEventTime:
    def test_is_the_speech_final_time_the_merge_window_is_the_gap_to_ended_at(self) -> None:
        s = setup()
        s.say("my phone is broken")
        event_at = s.clock.now()
        s.clock.advance(300)
        assert len(s.ended) == 1
        assert s.ended[0].end_event_at == event_at
        assert s.ended[0].ended_at == event_at + 300

    def test_is_the_last_speech_final_when_words_join_within_the_merge_window(self) -> None:
        s = setup()
        s.say("my phone is broken")
        s.clock.advance(200)
        s.say("it fell in water")
        second = s.clock.now()
        s.clock.advance(300)
        assert len(s.ended) == 1
        assert s.ended[0].text == "my phone is broken it fell in water"
        assert s.ended[0].end_event_at == second
        assert s.ended[0].ended_at == second + 300

    def test_is_the_utterance_end_time_when_no_speech_final_came_with_no_wait(self) -> None:
        s = setup()
        s.say("hello there", False)
        s.clock.advance(1_000)
        s.turns.handle(SttUtteranceEnd())
        assert s.ended[0].end_event_at == s.ended[0].ended_at
        assert s.ended[0].ended_at == s.clock.now()

    def test_does_not_carry_over_to_the_next_utterance(self) -> None:
        s = setup()
        s.say("first one")
        s.clock.advance(300)
        s.clock.advance(5_000)
        s.say("second one")
        at = s.clock.now()
        s.clock.advance(300)
        assert [u.end_event_at for u in s.ended] == [s.ended[0].end_event_at, at]
        assert s.ended[1].end_event_at > s.ended[0].end_event_at
