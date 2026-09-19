import os
import sys
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from estimator import (  # noqa: E402
    apply_depletion,
    band_to_qty,
    depletion_for_category,
    estimate_checkin,
    next_prediction_confidence,
    qty_to_band,
    snap_corrections,
)


class BandMappingTests(unittest.TestCase):
    def test_plenty_low_out_thresholds(self):
        self.assertEqual(qty_to_band(21), "plenty")
        self.assertEqual(qty_to_band(20), "low")
        self.assertEqual(qty_to_band(5), "low")
        self.assertEqual(qty_to_band(4.99), "out")
        self.assertEqual(qty_to_band(0), "out")
        self.assertEqual(qty_to_band(None), "out")

    def test_closing_check_snaps_qty_and_confidence(self):
        self.assertEqual(band_to_qty("plenty", 40), 40)
        self.assertEqual(band_to_qty("plenty", 12), 25.0)
        self.assertEqual(band_to_qty("low", 14), 14)
        self.assertEqual(band_to_qty("low", 40), 12.0)
        self.assertEqual(band_to_qty("out", 2), 2)
        self.assertEqual(band_to_qty("out", 18), 0.0)

        snapped = snap_corrections(
            [{"category_id": 1, "category_name": "Produce", "band": "low"}],
            [{"category_id": 1, "category_name": "Produce", "estimated_qty": 14, "band": "plenty"}],
        )
        self.assertEqual(len(snapped), 1)
        self.assertEqual(snapped[0]["source"], "volunteer_correction")
        self.assertEqual(snapped[0]["confidence"], 1.0)
        self.assertEqual(snapped[0]["band"], "low")
        self.assertEqual(snapped[0]["estimated_qty"], 14)


class DepletionModelTests(unittest.TestCase):
    def test_client_choice_uses_household_times_allocation(self):
        # 4 people × 1.5 lbs produce = 6 lbs
        self.assertEqual(
            depletion_for_category(
                distribution_model="client_choice",
                household_size=4,
                lbs_per_person=1.5,
            ),
            6.0,
        )

    def test_pre_packed_is_one_fixed_pack(self):
        self.assertEqual(
            depletion_for_category(
                distribution_model="pre_packed",
                household_size=6,
                lbs_per_person=2.0,
            ),
            2.0,
        )

    def test_list_uses_ordered_qty_when_provided(self):
        self.assertEqual(
            depletion_for_category(
                distribution_model="list",
                household_size=3,
                lbs_per_person=2.0,
                ordered_qty=4.5,
            ),
            4.5,
        )

    def test_never_goes_negative(self):
        self.assertEqual(apply_depletion(3, 10), 0.0)


class EstimateCheckinTests(unittest.TestCase):
    def setUp(self):
        self.shelf = [
            {
                "category_id": 1,
                "category_name": "Produce",
                "category_emoji": "🥕",
                "estimated_qty": 30,
                "band": "plenty",
                "lbs_per_person": 1.5,
                "source": "volunteer_correction",
                "confidence": 1.0,
            },
            {
                "category_id": 2,
                "category_name": "Protein",
                "category_emoji": "🥩",
                "estimated_qty": 8,
                "band": "low",
                "lbs_per_person": 1.5,
                "source": "prediction",
                "confidence": 0.8,
            },
        ]

    def test_client_choice_writes_prediction_rows(self):
        result = estimate_checkin(
            distribution_model="client_choice",
            household_size=4,
            shelf_rows=self.shelf,
        )
        produce = result["depletions"][0]
        protein = result["depletions"][1]
        self.assertEqual(produce["depleted"], 6.0)
        self.assertEqual(produce["remaining_qty"], 24.0)
        self.assertEqual(produce["band"], "plenty")
        self.assertEqual(produce["source"], "prediction")
        self.assertEqual(produce["confidence"], 0.80)
        self.assertEqual(protein["remaining_qty"], 2.0)
        self.assertEqual(protein["band"], "out")
        self.assertEqual(result["estimated_lbs"], 12.0)

    def test_list_only_depletes_ordered_categories(self):
        result = estimate_checkin(
            distribution_model="list",
            household_size=4,
            shelf_rows=self.shelf,
            order_items=[{"category_name": "Protein", "quantity": 3}],
        )
        self.assertEqual(result["depletions"][0]["depleted"], 0.0)
        self.assertEqual(result["depletions"][1]["depleted"], 3.0)
        self.assertEqual(result["estimated_lbs"], 3.0)

    def test_confidence_decays_across_predictions(self):
        first = next_prediction_confidence(1.0, "volunteer_correction")
        second = next_prediction_confidence(first, "prediction")
        self.assertEqual(first, 0.80)
        self.assertEqual(second, 0.72)


if __name__ == "__main__":
    unittest.main()
