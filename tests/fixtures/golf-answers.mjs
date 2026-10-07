/**
 * Golf answers the way the personal agent passes them: the user's exact words
 * as replyText, plus only what those words say.
 */
export const GOLF_ANSWER = Object.freeze({
  replyText: "18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m.",
  addRounds: [
    { day: "wednesday", holes: 18 },
    { day: "saturday", holes: 18 },
  ],
  focus: ["Wedges 50–100 m", "Putting inside 2 m"],
});

/** The example from the Saturday question itself, with a competition. */
export const COMPETITION_ANSWER = Object.freeze({
  replyText: "18 holes Wednesday and Saturday. Focus on wedges 50–100 m and putting inside 2 m. Saturday is a competition.",
  addRounds: [
    { day: "wednesday", holes: 18 },
    { day: "saturday", holes: 18, competition: true },
  ],
  focus: ["Wedges 50–100 m", "Putting inside 2 m"],
});

export const answerJson = (golf = GOLF_ANSWER, extra = {}) => JSON.stringify({ golf, ...extra });
