#include "ygo/duel.h"
#include "ygo/field.h"
#include "ygo/card.h"
#include "emscripten.h"

extern "C" uint32_t EMSCRIPTEN_KEEPALIVE ygosimSummonType(OCG_Duel handle, uint32_t controller, uint32_t location, uint32_t sequence, uint32_t code) {
    auto* pduel = static_cast<duel*>(handle);
    auto* target = pduel->game_field->get_field_card(controller, location, sequence);
    if(!target || (code && target->data.code != code))
        return 0;
    return static_cast<uint32_t>(target->summon.type);
}
