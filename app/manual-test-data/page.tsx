import { notFound } from 'next/navigation';
import ManualTestData from './manual-test-data';

export const dynamic = 'force-dynamic';

export default function ManualTestDataPage() {
  if (process.env.NODE_ENV !== 'development' || process.env.FLOW_MANUAL_TEST_MODE !== '1') {
    notFound();
  }
  return <ManualTestData />;
}
