import Button from '@components/buttonTsx';
import {GrowHeightReveal} from '@helpers/solid/animations';

export default function StarsMoreOptionsButton(props: {when: boolean, onClick: (event: MouseEvent) => any}) {
  return (
    <GrowHeightReveal when={props.when} appear={false} class="primary-action-focus-inset">
      <Button
        class="btn-primary btn-transparent primary popup-stars-more"
        icon="down"
        text="ShowMoreOptions"
        onClick={props.onClick}
      />
    </GrowHeightReveal>
  );
}
