export default {
	a: `b {c} '{d}' {num, number, percent}`,
	"b": `{guestCount, plural, =0 {No guests} one {{guestCount} guest} other {{guestCount} guests}}`,
	"c": `{guestCount, plural, offset:1 =0 {No guests} one {{guestCount} guest} other {{guestCount} guests}}`,
	"d": `{guestCount, plural, offset:1 =0 {No guests} one {{guestCount} guest} other {{guestCount} guests}}`
};
