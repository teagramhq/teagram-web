import LottieAnimation from '@components/lottieAnimation';
import lottieLoader, {LottieAssetName} from '@lib/lottie/lottieLoader';

export default function MediaHeaderLottieSticker(props: {
  class?: string,
  name: LottieAssetName,
  size: number,
  restartOnClick: boolean,
  onReady?: () => void
}) {
  return (
    <LottieAnimation
      class={props.class}
      size={props.size}
      lottieLoader={lottieLoader}
      restartOnClick={props.restartOnClick}
      name={props.name}
      onPromise={(promise) => promise.then(props.onReady)}
    />
  );
}
