// THE ONE PLACE A POSITION CAN ENTER THIS APP (JOS-98) — type or paste a `/loc`, get a marker.
//
// WHY A TEXT BOX ON A TOOLBAR THAT "DESCRIBES THE DRAWING". Because this control describes the
// drawing: it states the one position drawn on the surface, and it is the only way to put one
// there. The log never says where you are standing, so the alternative to a box is no marker at
// all — which is what the header used to say, in the flat voice of something that could not be
// fixed. It can be fixed; the user just has to say the number.
//
// THE FIELD EMPTIES ON SUCCESS AND THE CHIP TAKES OVER. Two controls, two jobs: the box is where a
// loc goes IN, the chip is what the app currently BELIEVES — stated in the game's own words and
// order so it can be checked against the game window without translation. A box that kept the text
// would be claiming to be both, and a marker you cleared would still be sitting in it.
//
// A REFUSAL IS PROSE AND IT STAYS PUT. The message names what the parser choked on and does not
// vanish on a timer — the user is about to retype something, and an error that disappears while
// they are reading it is worse than none. It clears when they type, which is the moment it stopped
// being true.
//
// CLEARING IS ON THE CHIP, NOT ON THE MAP. The marker persists across restarts; a stray click on a
// map surface must never be able to delete something the user typed and expects to find again.

import { useState, type JSX, type KeyboardEvent } from 'react'
import { Chip, IconButton, Stack, TextField, Typography } from '@mui/material'
import AddLocationAltIcon from '@mui/icons-material/AddLocationAlt'
import CancelIcon from '@mui/icons-material/Cancel'
import PlaceIcon from '@mui/icons-material/Place'
import type { EqLoc } from './mapGeometry'
import { formatLoc, parseLoc } from './locMarker'
import { Tooltip } from '../../lib/Tooltip'

export interface MapLocFieldProps {
  /** This zone's remembered marker, or null when it has none. */
  marker: EqLoc | null
  /** A well-formed reading was entered — place it, and remember it for this zone. */
  onPlace: (loc: EqLoc) => void
  /** Centre the view on the marker that is already placed. */
  onShow: () => void
  /** Forget this zone's marker. The only thing that ends one, besides entering another. */
  onClear: () => void
}

export default function MapLocField({ marker, onPlace, onShow, onClear }: MapLocFieldProps): JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)

  const commit = (): void => {
    const parsed = parseLoc(text)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setError(null)
    setText('')
    onPlace(parsed.loc)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'Enter') return
    commit()
    e.preventDefault()
  }

  return (
    <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap data-testid="maps-loc">
      <Tooltip title="Type /loc in game and paste the line here — north/south, west/east, elevation.">
        <TextField
          size="small"
          label="/loc marker"
          placeholder="1414.20, -735.55, 12.19"
          value={text}
          error={error != null}
          data-testid="maps-loc-field"
          slotProps={{
            htmlInput: { 'data-testid': 'maps-loc-input', 'aria-label': 'Place a marker from a /loc' }
          }}
          onChange={(e) => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={onKeyDown}
          sx={{ minWidth: 210 }}
        />
      </Tooltip>
      <Tooltip title="Place the marker">
        <span>
          <IconButton size="small" data-testid="maps-loc-place" disabled={text.trim() === ''} onClick={commit}>
            <AddLocationAltIcon fontSize="small" />
          </IconButton>
        </span>
      </Tooltip>
      {marker != null && (
        <Tooltip title="The location you entered. Click to centre on it; ✕ to remove it.">
          <Chip
            size="small"
            color="info"
            variant="outlined"
            icon={<PlaceIcon />}
            data-testid="maps-loc-chip"
            label={formatLoc(marker)}
            onClick={onShow}
            onDelete={onClear}
            // NAMED, because the chip carries TWO icons and they do OPPOSITE things: the leading
            // Place icon is part of the click target that centres on the marker, and this one
            // deletes it. MUI's own class names distinguish them, but a spec that clicks
            // `[chip] svg` gets the first — which is how the clear affordance was first asserted
            // green while doing nothing at all.
            deleteIcon={<CancelIcon data-testid="maps-loc-clear" titleAccess="Remove this marker" />}
          />
        </Tooltip>
      )}
      {error != null && (
        <Typography variant="caption" color="error" data-testid="maps-loc-error" sx={{ maxWidth: 420 }}>
          {error}
        </Typography>
      )}
    </Stack>
  )
}
